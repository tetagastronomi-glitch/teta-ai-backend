const pool = require("../db");
const { isReservationTodayAL, getNowHHMI_AL, normalizeTimeHHMI } = require("./time");

async function getRestaurantRules(restaurant_id) {
  const DEFAULT_MAX_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 6);
  const DEFAULT_CUTOFF = String(process.env.SAME_DAY_CUTOFF_HHMI || "11:00").trim();

  try {
    const q = await pool.query(
      `SELECT max_auto_confirm_people, same_day_cutoff_hhmi,
              opening_hours_start, opening_hours_end, max_capacity
       FROM public.restaurants WHERE id = $1 LIMIT 1;`,
      [restaurant_id]
    );

    const row = q.rows?.[0] || {};
    const maxPeopleRaw = Number(row.max_auto_confirm_people ?? DEFAULT_MAX_PEOPLE);
    const cutoffRaw = String(row.same_day_cutoff_hhmi ?? DEFAULT_CUTOFF).trim();

    const maxPeople = Number.isFinite(maxPeopleRaw) && maxPeopleRaw > 0 ? maxPeopleRaw : DEFAULT_MAX_PEOPLE;
    const cutoffHHMI = normalizeTimeHHMI(cutoffRaw) || normalizeTimeHHMI(DEFAULT_CUTOFF) || "11:00";
    const openingStart = normalizeTimeHHMI(String(row.opening_hours_start ?? "11:00")) || "11:00";
    const openingEnd = normalizeTimeHHMI(String(row.opening_hours_end ?? "21:00")) || "21:00";
    const maxCapacity = Number.isFinite(Number(row.max_capacity)) && Number(row.max_capacity) > 0
      ? Number(row.max_capacity) : 50;

    return { maxPeople, cutoffHHMI, openingStart, openingEnd, maxCapacity };
  } catch (e) {
    return {
      maxPeople: Number.isFinite(DEFAULT_MAX_PEOPLE) && DEFAULT_MAX_PEOPLE > 0 ? DEFAULT_MAX_PEOPLE : 6,
      cutoffHHMI: normalizeTimeHHMI(DEFAULT_CUTOFF) || "11:00",
      openingStart: "11:00",
      openingEnd: "21:00",
      maxCapacity: 50,
    };
  }
}

async function decideReservationStatus(restaurantId, dateStr, people) {
  const isTodayAL = await isReservationTodayAL(dateStr);
  const rules = await getRestaurantRules(restaurantId);
  const p = Number(people);
  const maxPeople = Number(rules.maxPeople);
  const cutoffHHMI = String(rules.cutoffHHMI || "11:00").trim();

  if (Number.isFinite(p) && Number.isFinite(maxPeople) && p > maxPeople) {
    return { isTodayAL, status: "Pending", reason: "group_over_threshold" };
  }

  if (isTodayAL) {
    const nowHHMI = await getNowHHMI_AL();
    const cutoffOk = /^(\d{2}):(\d{2})$/.test(cutoffHHMI);
    if (!cutoffOk) return { isTodayAL: true, status: "Pending", reason: "cutoff_invalid_failsafe" };
    if (nowHHMI >= cutoffHHMI) return { isTodayAL: true, status: "Pending", reason: "same_day_after_cutoff" };
    return { isTodayAL: true, status: "Confirmed", reason: "same_day_before_cutoff" };
  }

  return { isTodayAL: false, status: "Confirmed", reason: "future_auto_confirm" };
}

module.exports = { getRestaurantRules, decideReservationStatus };
