const express = require("express");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/simbrief/:username
//
// Server-side proxy for SimBrief's public "Latest OFP" fetcher API:
//   https://www.simbrief.com/api/xml.fetcher.php?username=<name>&json=1
// The frontend can't call simbrief.com directly from the browser (CORS), so
// this route fetches it here and returns just the fields the composer needs.
//
// NOTE: SimBrief's JSON field names have shifted slightly across API
// revisions, so several fallbacks are checked for each value. If a flight
// import comes back with missing fields, log `raw` (see catch below via
// DEBUG_SIMBRIEF=1) and adjust the field names to match what your account's
// OFP JSON actually contains.
router.get("/:username", requireAuth, async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      return res.status(400).json({ error: "SimBriefのユーザー名を入力してください。" });
    }

    const url = `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(username)}&json=1`;
    const upstream = await fetch(url);

    if (!upstream.ok) {
      return res.status(404).json({ error: "SimBriefのフライトプランが見つかりませんでした。ユーザー名をご確認ください。" });
    }

    const raw = await upstream.json();
    if (process.env.DEBUG_SIMBRIEF) console.log("SimBrief raw response:", JSON.stringify(raw));

    const origin = raw.origin || {};
    const destination = raw.destination || {};
    const general = raw.general || {};
    const times = raw.times || {};
    const aircraft = raw.aircraft || {};
    const atc = raw.atc || {};

    // Same "check several possible field names" defensiveness as the rest
    // of this route — different SimBrief OFP layouts/revisions have used
    // pos_lat/pos_long, lat/lon, and plat/plong at various points.
    function coord(obj, keys) {
      for (const key of keys) {
        const n = Number(obj[key]);
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "" && !Number.isNaN(n)) return n;
      }
      return null;
    }
    const originLat = coord(origin, ["pos_lat", "lat", "plat"]);
    const originLon = coord(origin, ["pos_long", "pos_lon", "lon", "plong"]);
    const destLat = coord(destination, ["pos_lat", "lat", "plat"]);
    const destLon = coord(destination, ["pos_long", "pos_lon", "lon", "plong"]);

    const durSec = Number(times.est_time_enroute ?? times.sched_time_enroute ?? 0) || null;
    const distanceNm = Number(general.route_distance ?? general.air_distance ?? general.gc_distance ?? 0) || null;
    const etaUnix = Number(times.est_in ?? times.sched_in ?? 0) || null;

    // Cruise altitude comes back in feet already in most OFP revisions.
    const cruiseAlt = Number(general.initial_altitude ?? general.cruise_altitude ?? 0) || null;

    // Callsign: prefer the ATC-filed callsign, fall back to airline+flight number.
    const flightNumber = general.flight_number || null;
    const callsign = atc.callsign
      || (general.icao_airline && flightNumber ? `${general.icao_airline}${flightNumber}` : null);

    // Alternate airport — same shape/fallbacks as origin/destination.
    const alternate = raw.alternate || {};
    const altIcao = alternate.icao_code || alternate.iata_code || null;
    const altName = alternate.name || null;
    const altLat = coord(alternate, ["pos_lat", "lat", "plat"]);
    const altLon = coord(alternate, ["pos_long", "pos_lon", "lon", "plong"]);

    function num(v) {
      const n = Number(v);
      return v !== undefined && v !== null && v !== "" && !Number.isNaN(n) ? n : null;
    }

    // Fuel figures are in whatever unit the OFP was generated in (lbs by
    // default, kgs if the pilot's SimBrief profile is set to metric) — the
    // unit label itself lives at `params.units` in most OFP revisions.
    const fuel = raw.fuel || {};
    const fuelUnit = (raw.params && raw.params.units) || raw.general?.units || "lbs";
    const blockFuel = num(fuel.plan_ramp);
    const taxiFuel = num(fuel.plan_taxi);
    const tripFuel = num(fuel.enroute_burn);
    const reserveFuel = num(fuel.reserve ?? fuel.plan_reserve);
    const altFuel = num(fuel.plan_alternate ?? fuel.alternate_burn);

    const weights = raw.weights || {};
    const estZfw = num(weights.est_zfw);
    const estTow = num(weights.est_tow);
    const estLdw = num(weights.est_ldw);
    const paxCount = num(weights.pax_count_actual ?? weights.pax_count);

    // Full route waypoints (navlog), used to draw the actual flown path on
    // the map instead of a straight origin->destination line, and to show
    // an OFP-style navlog list. `fix` comes back as a single object (not an
    // array) when the route only has one fix, so it's normalized here.
    // SID/STAR procedure fixes are kept too — they're still part of the
    // flown path, just flagged via `isProcedure` in case the frontend wants
    // to style/hide them differently.
    let rawFixes = raw.navlog && raw.navlog.fix ? raw.navlog.fix : [];
    if (!Array.isArray(rawFixes)) rawFixes = [rawFixes];
    const waypoints = rawFixes
      .map((wp) => ({
        ident: wp.ident || null,
        lat: coord(wp, ["pos_lat", "lat", "plat"]),
        lon: coord(wp, ["pos_long", "pos_lon", "lon", "plong"]),
        altitude: num(wp.altitude_feet),
        isProcedure: wp.is_sid_star === "1" || wp.is_sid_star === 1,
      }))
      .filter((wp) => wp.ident && wp.lat != null && wp.lon != null);

    const flight = {
      originIcao: origin.icao_code || origin.iata_code || null,
      originName: origin.name || null,
      originLat,
      originLon,
      destIcao: destination.icao_code || destination.iata_code || null,
      destName: destination.name || null,
      destLat,
      destLon,
      durMin: durSec ? Math.round(durSec / 60) : null,
      distance: distanceNm ? Math.round(distanceNm) : null,
      eta: etaUnix ? new Date(etaUnix * 1000).toISOString() : null,
      // Extra detail for a richer flight card — any of these may be absent
      // depending on the SimBrief account/aircraft profile, so the frontend
      // must treat them all as optional.
      aircraftIcao: aircraft.icao_code || null,
      aircraftName: aircraft.name || null,
      callsign,
      route: general.route || null,
      cruiseAlt,
      // OFP-style detail for the flight detail / full-screen briefing views.
      altIcao,
      altName,
      altLat,
      altLon,
      fuelUnit,
      blockFuel,
      taxiFuel,
      tripFuel,
      reserveFuel,
      altFuel,
      estZfw,
      estTow,
      estLdw,
      paxCount,
      // Ordered route fixes (origin -> ... -> destination) for plotting the
      // actual flown path and an OFP-style navlog list. May be empty for
      // very short/simple routes or older SimBrief accounts.
      waypoints,
    };

    if (!flight.originIcao && !flight.destIcao) {
      return res.status(422).json({ error: "SimBriefのフライトプランを解析できませんでした。" });
    }

    res.json({ flight });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "SimBriefからの取得に失敗しました。" });
  }
});

module.exports = router;
