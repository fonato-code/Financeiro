/**
 * Feriados nacionais brasileiros (fixos + móveis a partir da Páscoa).
 * Usado para dias sem rendimento de CDB/Cofrinho em dia útil.
 */
(function (global) {
  'use strict';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toIso(y, m, d) {
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function fromDate(dt) {
    return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  function addDays(d, days) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
    x.setDate(x.getDate() + days);
    return x;
  }

  /** Domingo de Páscoa — algoritmo gregoriano */
  function easterSunday(y) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day, 12, 0, 0);
  }

  function compareIso(a, b) {
    return a.localeCompare(b);
  }

  function holidaysForYear(year) {
    const list = [];
    const addFixed = (month, day, name) => {
      list.push({ date: toIso(year, month, day), name });
    };

    addFixed(1, 1, 'Confraternização Universal');
    addFixed(4, 21, 'Tiradentes');
    addFixed(5, 1, 'Dia do Trabalho');
    addFixed(9, 7, 'Independência do Brasil');
    addFixed(10, 12, 'Nossa Senhora Aparecida');
    addFixed(11, 2, 'Finados');
    addFixed(11, 15, 'Proclamação da República');
    addFixed(11, 20, 'Dia Nacional de Zumbi e da Consciência Negra');
    addFixed(12, 25, 'Natal');

    const e = easterSunday(year);
    list.push({ date: fromDate(addDays(e, -48)), name: 'Segunda-feira de Carnaval' });
    list.push({ date: fromDate(addDays(e, -47)), name: 'Terça-feira de Carnaval' });
    list.push({ date: fromDate(addDays(e, -2)), name: 'Sexta-feira Santa' });
    list.push({ date: fromDate(addDays(e, 60)), name: 'Corpus Christi' });

    return list;
  }

  function holidayMapBetween(fromIso, toIso) {
    if (!fromIso || !toIso || compareIso(fromIso, toIso) > 0) {
      return {};
    }
    const y0 = parseInt(fromIso.slice(0, 4), 10);
    const y1 = parseInt(toIso.slice(0, 4), 10);
    const map = {};
    for (let y = y0; y <= y1; y++) {
      for (const h of holidaysForYear(y)) {
        if (compareIso(h.date, fromIso) < 0 || compareIso(h.date, toIso) > 0) continue;
        if (map[h.date]) {
          if (!map[h.date].includes(h.name)) {
            map[h.date] = `${map[h.date]} · ${h.name}`;
          }
        } else {
          map[h.date] = h.name;
        }
      }
    }
    return map;
  }

  function holidayListBetween(fromIso, toIso) {
    const map = holidayMapBetween(fromIso, toIso);
    return Object.keys(map)
      .sort()
      .map((iso) => ({ date: iso, name: map[iso] }));
  }

  global.BrHolidays = {
    holidayMapBetween,
    holidayListBetween,
    holidaysForYear,
  };
})(typeof window !== 'undefined' ? window : globalThis);
