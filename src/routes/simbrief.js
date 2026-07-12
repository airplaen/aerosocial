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

    const durSec = Number(times.est_time_enroute ?? times.sched_time_enroute ?? 0) || null;
    const distanceNm = Number(general.route_distance ?? general.air_distance ?? general.gc_distance ?? 0) || null;
    const etaUnix = Number(times.est_in ?? times.sched_in ?? 0) || null;

    // Cruise altitude comes back in feet already in most OFP revisions.
    const cruiseAlt = Number(general.initial_altitude ?? general.cruise_altitude ?? 0) || null;

    // Callsign: prefer the ATC-filed callsign, fall back to airline+flight number.
    const flightNumber = general.flight_number || null;
    const callsign = atc.callsign
      || (general.icao_airline && flightNumber ? `${general.icao_airline}${flightNumber}` : null);

    const flight = {
      originIcao: origin.icao_code || origin.iata_code || null,
      originName: origin.name || null,
      destIcao: destination.icao_code || destination.iata_code || null,
      destName: destination.name || null,
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
