const pool = require("../db");

function formatALDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleString("sq-AL", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getTodayAL() {
  const q = await pool.query(`
    SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date, 'YYYY-MM-DD') AS d
  `);
  return String(q.rows?.[0]?.d || "").trim();
}

function toYMD(x) {
  if (!x) return "";
  return String(x).trim().slice(0, 10);
}

async function isReservationTodayAL(reservationDate) {
  const todayYMD = await getTodayAL();
  const reqYMD = toYMD(reservationDate);
  return reqYMD === todayYMD;
}

function normalizeTimeHHMI(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

async function getNowHHMI_AL() {
  const q = await pool.query(`
    SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::time, 'HH24:MI') AS now_hhmi
  `);
  return normalizeTimeHHMI(q.rows?.[0]?.now_hhmi) || "00:00";
}

async function isTimePassedTodayAL(reservationDate, reservationTimeHHMI) {
  const reqYMD = toYMD(reservationDate);
  const todayYMD = await getTodayAL();
  if (reqYMD !== todayYMD) return false;
  const timeHHMI = normalizeTimeHHMI(reservationTimeHHMI);
  if (!timeHHMI) return false;
  const nowHHMI = await getNowHHMI_AL();
  return timeHHMI < nowHHMI;
}

async function rejectIfTimePassedTodayAL(reservationDate, rawTime) {
  const timeHHMI = normalizeTimeHHMI(rawTime);
  if (!timeHHMI) {
    return { ok: false, error_code: "INVALID_TIME", message: "Ora është e pavlefshme." };
  }
  const passed = await isTimePassedTodayAL(reservationDate, timeHHMI);
  if (passed) {
    return {
      ok: false,
      error_code: "TIME_PASSED",
      message: "Ora që ke zgjedhur ka kaluar.\nTë lutem zgjidh një orë tjetër sot ose një ditë tjetër.",
    };
  }
  return { ok: true, timeHHMI };
}

function subtractMinutesHHMI(hhmi, minutes) {
  const t = normalizeTimeHHMI(hhmi) || "00:00";
  const mins = Number(minutes);
  const safeMins = Number.isFinite(mins) && mins >= 0 ? Math.floor(mins) : 0;
  const [h, m] = t.split(":").map(Number);
  let total = h * 60 + m - safeMins;
  if (!Number.isFinite(total) || total < 0) total = 0;
  if (total > 23 * 60 + 59) total = 23 * 60 + 59;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

module.exports = {
  formatALDate,
  getTodayAL,
  toYMD,
  isReservationTodayAL,
  normalizeTimeHHMI,
  getNowHHMI_AL,
  isTimePassedTodayAL,
  rejectIfTimePassedTodayAL,
  subtractMinutesHHMI,
};
