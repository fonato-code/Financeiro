(function () {
  const { createApp } = Vue;

  const STORAGE_KEY = 'financeiro-investment-state-v1';

  /** CDI anualizado (% a.a., base 252) — BCB SGS */
  const CDI_SGS_CODE = 4389;

  function isoToBrDate(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const p = iso.split('-');
    if (p.length !== 3) return '';
    return `${p[2]}/${p[1]}/${p[0]}`;
  }

  function bcbCdiSeriesUrl(dataInicialBr, dataFinalBr) {
    const di = encodeURIComponent(dataInicialBr);
    const df = encodeURIComponent(dataFinalBr);
    return `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${CDI_SGS_CODE}/dados?formato=json&dataInicial=${di}&dataFinal=${df}`;
  }

  /** Pontos { dateIso, annualDecimal, dataBr } ordenados por dateIso. */
  function buildSortedCdiPointsFromSgs(rows) {
    if (!Array.isArray(rows)) return [];
    const list = [];
    for (const r of rows) {
      const t = parseBrDate(r.data);
      const pct = parseSgsValor(r.valor);
      if (!t || Number.isNaN(pct) || pct < 0) continue;
      const y = t.getFullYear();
      const m = String(t.getMonth() + 1).padStart(2, '0');
      const d = String(t.getDate()).padStart(2, '0');
      const dateIso = `${y}-${m}-${d}`;
      list.push({
        dateIso,
        annualDecimal: pct / 100,
        dataBr: typeof r.data === 'string' ? r.data : '',
      });
    }
    list.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
    return list;
  }

  const BCB_CDI_LAST_JSON_URL = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${CDI_SGS_CODE}/dados/ultimos/1?formato=json`;

  /**
   * Último CDI da série com data <= iso (carry-forward). Se iso antes do primeiro ponto, usa o primeiro.
   */
  function annualRateFromSortedCdiPoints(sortedPoints, iso, flatFallback) {
    if (!sortedPoints || sortedPoints.length === 0) return flatFallback;
    if (compareIso(iso, sortedPoints[0].dateIso) < 0) return sortedPoints[0].annualDecimal;
    let lo = 0;
    let hi = sortedPoints.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedPoints[mid].dateIso <= iso) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return sortedPoints[ans].annualDecimal;
  }

  function parseSgsValor(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? NaN : n;
  }

  function parseBrDate(s) {
    if (typeof s !== 'string') return null;
    const p = s.split('/');
    if (p.length !== 3) return null;
    const d = Number(p[0]);
    const m = Number(p[1]);
    const y = Number(p[2]);
    if (!d || !m || !y) return null;
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function pickLatestSgsRow(rows) {
    let best = null;
    let bestT = -1;
    for (const r of rows) {
      const t = parseBrDate(r.data);
      if (!t) continue;
      const ts = t.getTime();
      if (ts >= bestT) {
        bestT = ts;
        best = r;
      }
    }
    return best;
  }

  function parseISODate(s) {
    if (!s) return null;
    const d = new Date(s + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function daysBetween(a, b) {
    return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
  }

  function dateToIso(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  function addOneCalendarDayIso(iso) {
    const d = parseISODate(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + 1);
    return dateToIso(d);
  }

  function subtractOneCalendarDayIso(iso) {
    const d = parseISODate(iso);
    if (!d) return iso;
    d.setDate(d.getDate() - 1);
    return dateToIso(d);
  }

  function addCalendarDaysIso(iso, deltaDays) {
    const d = parseISODate(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + deltaDays);
    return dateToIso(d);
  }

  /** Segunda-feira da semana (calendário local) que contém `iso`. */
  function mondayOfWeekContainingIso(iso) {
    const d = parseISODate(iso);
    if (!d) return iso;
    const day = d.getDay();
    const toMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + toMonday);
    return dateToIso(d);
  }

  function compareIso(a, b) {
    return a.localeCompare(b);
  }

  function isWeekdayIso(iso) {
    const d = parseISODate(iso);
    if (!d) return false;
    const w = d.getDay();
    return w !== 0 && w !== 6;
  }

  /** Dia útil com rendimento Cofrinho: não é fim de semana nem feriado nacional. */
  function isCofrinhoYieldDay(iso, holidayMap) {
    if (!isWeekdayIso(iso)) return false;
    const hm = holidayMap || {};
    return !hm[iso];
  }

  /** Segunda–sexta sem feriado nacional (dia útil de calendário; pode não haver postagem de rendimento). */
  function isCalendarCofrinhoBusinessDay(iso, holidayMap) {
    if (!isWeekdayIso(iso)) return false;
    const hm = holidayMap || {};
    return !hm[iso];
  }

  /**
   * Postagem de rendimento na manhã de `iso`: saldo fechado do dia anterior.
   * Requer ontem como dia útil sem feriado (`isCofrinhoYieldDay(prev)`).
   * — Sábado: credita fechamento da sexta (Diff no sábado).
   * — Domingo: sem postagem.
   * — Dia útil sem feriado: credita.
   * — Feriado em dia da semana (ex. Tiradentes, Sexta Santa): credita fechamento do dia útil anterior.
   */
  function shouldPostCofrinhoYieldOnDate(iso, holidayMap, annualRateDecimal) {
    if (!annualRateDecimal || annualRateDecimal <= 0) return false;
    const hm = holidayMap || {};
    const prev = subtractOneCalendarDayIso(iso);
    if (!isCofrinhoYieldDay(prev, hm)) return false;
    const d = parseISODate(iso);
    if (!d) return false;
    const dow = d.getDay();
    if (dow === 6) return true;
    if (dow === 0) return false;
    if (isCofrinhoYieldDay(iso, hm)) return true;
    if (isWeekdayIso(iso) && hm[iso]) return true;
    return false;
  }

  /** Dias corridos desde open até cur (inclusive), mínimo 1 se cur >= open */
  function calendarDaysInclusive(openIso, curIso) {
    const a = parseISODate(openIso);
    const b = parseISODate(curIso);
    if (!a || !b || b < a) return 0;
    return Math.round(daysBetween(a, b)) + 1;
  }

  /**
   * IOF sobre o rendimento — tabela regressiva (dias corridos desde a aplicação do aporte).
   * Índice 1 = primeiro dia, …, 30 = 0%. Após 30 dias, isento.
   */
  const IOF_ON_YIELD_PCT = [
    0, 96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50, 46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3, 0,
  ];

  function iofRateOnYield(dayInclusive) {
    if (dayInclusive < 1 || dayInclusive > 30) return 0;
    return IOF_ON_YIELD_PCT[dayInclusive] / 100;
  }

  /** IR sobre rendimento, alíquota conforme dias corridos do aporte (regime de renda fixa). */
  function irRateOnYield(dayInclusive) {
    if (dayInclusive <= 180) return 0.225;
    if (dayInclusive <= 360) return 0.2;
    if (dayInclusive <= 720) return 0.175;
    return 0.15;
  }

  function fifoWithdraw(layers, amount) {
    let left = Math.max(0, amount);
    for (const L of layers) {
      if (left <= 1e-12) break;
      if (L.principal <= 1e-12) continue;
      const take = Math.min(L.principal, left);
      L.principal -= take;
      left -= take;
    }
    return layers.filter((L) => L.principal > 1e-9);
  }

  function growBalance(balance, fromStr, toStr, annualRate, compounding) {
    if (balance === 0) return balance;
    const start = parseISODate(fromStr);
    const end = parseISODate(toStr);
    if (!start || !end || end <= start) return balance;

    if (annualRate <= 0) return balance;

    if (compounding === 'monthly') {
      const d = daysBetween(start, end);
      const months = d / (365 / 12);
      const mFactor = Math.pow(1 + annualRate, 1 / 12);
      return balance * Math.pow(mFactor, months);
    }

    const d = daysBetween(start, end);
    return balance * Math.pow(1 + annualRate, d / 365);
  }

  function simulateAll(initialBalance, flows, periodStart, horizonDate, annualRate, compounding) {
    const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
    let bal = Number(initialBalance) || 0;
    let z = Number(initialBalance) || 0;
    let cur = periodStart;

    for (const f of sorted) {
      bal = growBalance(bal, cur, f.date, annualRate, compounding);
      z = growBalance(z, cur, f.date, 0, compounding);
      bal += f.amount;
      z += f.amount;
      cur = f.date;
    }
    bal = growBalance(bal, cur, horizonDate, annualRate, compounding);
    z = growBalance(z, cur, horizonDate, 0, compounding);
    return { finalBalance: bal, balanceZeroRate: z };
  }

  function balanceZeroOnly(initialBalance, flows, periodStart, horizonDate) {
    const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
    let z = Number(initialBalance) || 0;
    let curZ = periodStart;
    for (const f of sorted) {
      z = growBalance(z, curZ, f.date, 0, 'daily');
      z += f.amount;
      curZ = f.date;
    }
    z = growBalance(z, curZ, horizonDate, 0, 'daily');
    return z;
  }

  /**
   * Cofrinho / CDB: rendimento em dias úteis (base 252), impostos só sobre o rendimento.
   * Ordem do dia: postagem do rendimento (sobre saldo fechado de ontem) → movimentações do dia.
   * Postagem só se hoje e ontem forem dias de rendimento (janela 23:49–02:01 e pausas em não úteis).
   * Camadas FIFO por data de cada aporte; retiradas consomem os aportes mais antigos.
   * IOF: tabela dias 1–30 (corridos) sobre o rendimento do dia; IR: regressivo por dias corridos do aporte.
   */
  function simulateCofrinho(initialBalance, flows, periodStart, horizonDate, holidayMap, resolveAnnualRate) {
    const hm = holidayMap || {};
    const sorted = [...flows].sort((a, b) => {
      const c = a.date.localeCompare(b.date);
      return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
    });

    const layers = [];
    if ((Number(initialBalance) || 0) > 0) {
      layers.push({ principal: Number(initialBalance), open: periodStart });
    }

    let totalGross = 0;
    let totalIof = 0;
    let totalIr = 0;
    let businessDays = 0;

    let cur = periodStart;
    const end = horizonDate;
    const zRef = balanceZeroOnly(initialBalance, flows, periodStart, horizonDate);
    if (compareIso(cur, end) > 0) {
      const z = layers.reduce((s, L) => s + L.principal, 0);
      return {
        finalBalance: z,
        balanceZeroRate: zRef,
        totalGrossYield: 0,
        totalIof: 0,
        totalIr: 0,
        totalNetYield: 0,
        businessDays: 0,
      };
    }

    const flowsByDate = new Map();
    for (const f of sorted) {
      if (!flowsByDate.has(f.date)) flowsByDate.set(f.date, []);
      flowsByDate.get(f.date).push(f);
    }

    while (compareIso(cur, end) <= 0) {
      const dayFlows = flowsByDate.get(cur) || [];

      const rCur = resolveAnnualRate(cur);
      if (shouldPostCofrinhoYieldOnDate(cur, hm, rCur)) {
        const fator = Math.pow(1 + rCur, 1 / 252) - 1;
        businessDays += 1;
        for (const layer of layers) {
          if (layer.principal <= 1e-12) continue;
          const gross = layer.principal * fator;
          const n = calendarDaysInclusive(layer.open, cur);
          const iofPct = iofRateOnYield(n);
          const irPct = irRateOnYield(n);
          const iof = gross * iofPct;
          const baseIr = gross - iof;
          const ir = baseIr * irPct;
          const net = gross - iof - ir;
          layer.principal += net;
          totalGross += gross;
          totalIof += iof;
          totalIr += ir;
        }
      }

      for (const f of dayFlows) {
        if (f.amount >= 0) {
          layers.push({ principal: f.amount, open: f.date });
        } else {
          fifoWithdraw(layers, -f.amount);
        }
      }

      if (cur === end) break;
      cur = addOneCalendarDayIso(cur);
    }

    const finalBalance = layers.reduce((s, L) => s + L.principal, 0);
    const totalNetYield = totalGross - totalIof - totalIr;

    return {
      finalBalance,
      balanceZeroRate: zRef,
      totalGrossYield: totalGross,
      totalIof,
      totalIr,
      totalNetYield,
      businessDays,
    };
  }

  function sumLayersPrincipal(layers) {
    return layers.reduce((s, L) => s + L.principal, 0);
  }

  const WEEKDAY_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  function weekdayPtFromIso(iso) {
    const d = parseISODate(iso);
    if (!d) return '';
    return WEEKDAY_PT[d.getDay()];
  }

  /**
   * Linhas diárias espelhando simulateCofrinho: rendimento na manhã (saldo de ontem) → movimentações.
   * diff = rendimento líquido postado naquela data.
   * calendarBusinessDay = segunda–sexta sem feriado (coluna “dia útil”, independente de Diff).
   */
  function buildCofrinhoDailyLedger(initialBalance, flows, periodStart, horizonDate, todayIso, holidayMap, resolveAnnualRate) {
    const hm = holidayMap || {};
    const sorted = [...flows].sort((a, b) => {
      const c = a.date.localeCompare(b.date);
      return c !== 0 ? c : String(a.id).localeCompare(String(b.id));
    });

    const layers = [];
    if ((Number(initialBalance) || 0) > 0) {
      layers.push({ principal: Number(initialBalance), open: periodStart });
    }

    const rows = [];
    let cur = periodStart;
    const end = horizonDate;
    if (compareIso(cur, end) > 0) return rows;

    const flowsByDate = new Map();
    for (const f of sorted) {
      if (!flowsByDate.has(f.date)) flowsByDate.set(f.date, []);
      flowsByDate.get(f.date).push(f);
    }

    while (compareIso(cur, end) <= 0) {
      const dayFlows = flowsByDate.get(cur) || [];
      let movement = 0;
      for (const f of dayFlows) {
        movement += f.amount;
      }

      let diff = 0;
      let dayIof = 0;
      let dayIr = 0;
      let dayGross = 0;
      let dayTaxableBaseIr = 0;
      const rCur = resolveAnnualRate(cur);
      const postedYield = shouldPostCofrinhoYieldOnDate(cur, hm, rCur);
      if (postedYield) {
        const fator = Math.pow(1 + rCur, 1 / 252) - 1;
        for (const layer of layers) {
          if (layer.principal <= 1e-12) continue;
          const gross = layer.principal * fator;
          const n = calendarDaysInclusive(layer.open, cur);
          const iofPct = iofRateOnYield(n);
          const irPct = irRateOnYield(n);
          const iof = gross * iofPct;
          const baseIr = gross - iof;
          const ir = baseIr * irPct;
          const net = gross - iof - ir;
          layer.principal += net;
          diff += net;
          dayIof += iof;
          dayIr += ir;
          dayGross += gross;
          dayTaxableBaseIr += baseIr;
        }
      }
      let dailyIofPct = null;
      let dailyIrPct = null;
      if (postedYield) {
        dailyIofPct = dayGross > 1e-14 ? (dayIof / dayGross) * 100 : 0;
        dailyIrPct = dayTaxableBaseIr > 1e-14 ? (dayIr / dayTaxableBaseIr) * 100 : 0;
      }

      for (const f of dayFlows) {
        if (f.amount >= 0) {
          layers.push({ principal: f.amount, open: f.date });
        } else {
          fifoWithdraw(layers, -f.amount);
        }
      }

      const valor = sumLayersPrincipal(layers);
      const d = parseISODate(cur);
      const projected = compareIso(cur, todayIso) > 0;
      const holidayName = isWeekdayIso(cur) && hm[cur] ? hm[cur] : null;

      rows.push({
        dateIso: cur,
        weekday: weekdayPtFromIso(cur),
        calendarBusinessDay: isCalendarCofrinhoBusinessDay(cur, hm),
        holidayName,
        movement,
        movementFlows: dayFlows.map((f) => ({
          id: f.id,
          amount: f.amount,
          label: f.label,
          date: f.date,
        })),
        valor,
        diff: postedYield ? diff : null,
        dailyIof: postedYield ? dayIof : null,
        dailyIr: postedYield ? dayIr : null,
        dailyIofPct: postedYield ? dailyIofPct : null,
        dailyIrPct: postedYield ? dailyIrPct : null,
        /** CDI (ou taxa anual efetiva do dia) em decimal a.a., ex.: 0,1415 = 14,15%. */
        cdiAnnualDecimal: rCur,
        projected,
        month: d ? d.getMonth() + 1 : 1,
        year: d ? d.getFullYear() : new Date().getFullYear(),
      });

      if (cur === end) break;
      cur = addOneCalendarDayIso(cur);
    }

    return rows;
  }

  function defaultData() {
    const today = new Date();
    const iso = (dt) => {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };
    const horizon = new Date(today);
    horizon.setFullYear(horizon.getFullYear() + 1);
    return {
      simulationStart: iso(today),
      annualRatePercent: 10,
      cdiSynced: true,
      cdiReferenceDate: '',
      cdiSeriesPoints: [],
      cdiSeriesFrom: '',
      cdiSeriesTo: '',
      cdiLoading: false,
      cdiError: '',
      _cdiRefreshTimer: null,
      aporteYieldModalKind: null,
      aporteYieldModalFlow: null,
      aporteYieldModalRows: [],
      aporteYieldTableCopyOk: false,
      _aporteYieldCopyTimer: null,
      compounding: 'daily',
      initialBalance: 0,
      horizonDate: iso(horizon),
      flows: [],
      newFlow: {
        date: iso(today),
        kind: 'in',
        amount: 1000,
        label: '',
      },
      cofrinhoTaxes: true,
      ledgerFilterMonth: today.getMonth() + 1,
      ledgerFilterYear: today.getFullYear(),
      movementsSectionExpanded: true,
      summarySectionExpanded: true,
      paramsSectionExpanded: true,
      incomeSectionExpanded: true,
      ledgerSectionExpanded: true,
      flowsImportMessage: '',
    };
  }

  function sanitizeLoaded(raw, defaults) {
    if (!raw || typeof raw !== 'object') return null;
    const out = { ...defaults };

    if (typeof raw.simulationStart === 'string') out.simulationStart = raw.simulationStart;
    if (typeof raw.horizonDate === 'string') out.horizonDate = raw.horizonDate;
    if (raw.compounding === 'daily' || raw.compounding === 'monthly') out.compounding = raw.compounding;
    const arp = Number(raw.annualRatePercent);
    if (!Number.isNaN(arp)) out.annualRatePercent = arp;
    if (typeof raw.cdiSynced === 'boolean') out.cdiSynced = raw.cdiSynced;
    else out.cdiSynced = false;
    if (typeof raw.cdiReferenceDate === 'string') out.cdiReferenceDate = raw.cdiReferenceDate;
    if (typeof raw.cofrinhoTaxes === 'boolean') out.cofrinhoTaxes = raw.cofrinhoTaxes;
    else out.cofrinhoTaxes = true;
    const lfm = Number(raw.ledgerFilterMonth);
    if (!Number.isNaN(lfm) && lfm >= 1 && lfm <= 12) out.ledgerFilterMonth = lfm;
    const lfy = Number(raw.ledgerFilterYear);
    if (!Number.isNaN(lfy) && lfy >= 2000 && lfy <= 2100) out.ledgerFilterYear = lfy;
    if (typeof raw.movementsSectionExpanded === 'boolean') out.movementsSectionExpanded = raw.movementsSectionExpanded;
    if (typeof raw.summarySectionExpanded === 'boolean') out.summarySectionExpanded = raw.summarySectionExpanded;
    if (typeof raw.paramsSectionExpanded === 'boolean') out.paramsSectionExpanded = raw.paramsSectionExpanded;
    if (typeof raw.incomeSectionExpanded === 'boolean') out.incomeSectionExpanded = raw.incomeSectionExpanded;
    if (typeof raw.ledgerSectionExpanded === 'boolean') out.ledgerSectionExpanded = raw.ledgerSectionExpanded;
    const ib = Number(raw.initialBalance);
    if (!Number.isNaN(ib)) out.initialBalance = ib;

    if (raw.newFlow && typeof raw.newFlow === 'object') {
      out.newFlow = { ...defaults.newFlow, ...raw.newFlow };
      if (out.newFlow.kind !== 'in' && out.newFlow.kind !== 'out') out.newFlow.kind = 'in';
      const amt = Number(out.newFlow.amount);
      out.newFlow.amount = Number.isNaN(amt) ? defaults.newFlow.amount : amt;
      if (typeof out.newFlow.label !== 'string') out.newFlow.label = '';
      if (typeof out.newFlow.date !== 'string') out.newFlow.date = defaults.newFlow.date;
    }

    if (Array.isArray(raw.flows)) {
      out.flows = raw.flows
        .map((f) => {
          if (!f || typeof f.date !== 'string') return null;
          const amt = Number(f.amount);
          if (Number.isNaN(amt)) return null;
          return {
            id: typeof f.id === 'string' ? f.id : `f-${Date.now()}-${Math.random()}`,
            date: f.date,
            amount: amt,
            label: typeof f.label === 'string' ? f.label : '',
          };
        })
        .filter(Boolean);
    }

    return out;
  }

  function parseMoneyFlexible(s) {
    let x = String(s ?? '')
      .trim()
      .replace(/R\$\s?/gi, '');
    if (!x) return NaN;
    if (x.includes(',') && x.includes('.')) {
      if (x.lastIndexOf(',') > x.lastIndexOf('.')) {
        x = x.replace(/\./g, '').replace(',', '.');
      } else {
        x = x.replace(/,/g, '');
      }
    } else if (x.includes(',')) {
      x = x.replace(',', '.');
    }
    const n = parseFloat(x);
    return Number.isNaN(n) ? NaN : n;
  }

  function parseDateFlexible(s) {
    const t = String(s ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    return null;
  }

  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  createApp({
    data() {
      return defaultData();
    },
    created() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const defs = defaultData();
        const next = sanitizeLoaded(parsed, defs);
        if (!next) return;
        this.simulationStart = next.simulationStart;
        this.horizonDate = next.horizonDate;
        this.compounding = next.compounding;
        this.annualRatePercent = next.annualRatePercent;
        this.cdiSynced = next.cdiSynced;
        this.cdiReferenceDate = next.cdiReferenceDate;
        this.cofrinhoTaxes = next.cofrinhoTaxes;
        this.ledgerFilterMonth = next.ledgerFilterMonth;
        this.ledgerFilterYear = next.ledgerFilterYear;
        this.movementsSectionExpanded = next.movementsSectionExpanded;
        this.summarySectionExpanded = next.summarySectionExpanded;
        this.paramsSectionExpanded = next.paramsSectionExpanded;
        this.incomeSectionExpanded = next.incomeSectionExpanded;
        this.ledgerSectionExpanded = next.ledgerSectionExpanded;
        this.initialBalance = next.initialBalance;
        this.flows = next.flows;
        this.newFlow = { ...next.newFlow };
      } catch (_) {
        /* ignore storage corrupto */
      }
    },
    watch: {
      simulationStart() {
        this.saveToStorage();
        this.$nextTick(() => {
          this.clampLedgerYearToRange();
          this.scheduleCdiRefresh();
        });
      },
      horizonDate() {
        this.saveToStorage();
        this.$nextTick(() => {
          this.clampLedgerYearToRange();
          this.scheduleCdiRefresh();
        });
      },
      periodStart() {
        this.$nextTick(() => {
          this.clampLedgerYearToRange();
          this.scheduleCdiRefresh();
        });
      },
      compounding() {
        this.saveToStorage();
      },
      annualRatePercent() {
        this.saveToStorage();
      },
      cdiSynced(newVal) {
        this.saveToStorage();
        if (newVal) {
          this.refreshCdiFromBcb();
        } else {
          this.cdiSeriesPoints = [];
          this.cdiSeriesFrom = '';
          this.cdiSeriesTo = '';
        }
      },
      cdiReferenceDate() {
        this.saveToStorage();
      },
      cofrinhoTaxes() {
        this.saveToStorage();
      },
      ledgerFilterMonth() {
        this.saveToStorage();
      },
      ledgerFilterYear() {
        this.saveToStorage();
      },
      movementsSectionExpanded() {
        this.saveToStorage();
      },
      summarySectionExpanded() {
        this.saveToStorage();
      },
      paramsSectionExpanded() {
        this.saveToStorage();
      },
      incomeSectionExpanded() {
        this.saveToStorage();
      },
      ledgerSectionExpanded() {
        this.saveToStorage();
      },
      initialBalance() {
        this.saveToStorage();
      },
      flows: {
        deep: true,
        handler() {
          this.saveToStorage();
          this.scheduleCdiRefresh();
        },
      },
      newFlow: {
        deep: true,
        handler() {
          this.saveToStorage();
        },
      },
    },
    mounted() {
      if (this.cdiSynced) {
        this.refreshCdiFromBcb();
      }
      this.$nextTick(() => this.clampLedgerYearToRange());
    },
    computed: {
      annualRate() {
        return (Number(this.annualRatePercent) || 0) / 100;
      },
      /** Taxa anual em decimal por data ISO (postagem); CDI oficial usa série BCB no período. */
      cdiResolveAnnualRate() {
        const flat = (Number(this.annualRatePercent) || 0) / 100;
        if (!this.cdiSynced) {
          return () => flat;
        }
        const pts = this.cdiSeriesPoints;
        if (!Array.isArray(pts) || pts.length === 0) {
          return () => flat;
        }
        return (iso) => annualRateFromSortedCdiPoints(pts, iso, flat);
      },
      todayIso() {
        return dateToIso(new Date());
      },
      ledgerYearOptions() {
        const y0 = parseInt(String(this.periodStart).slice(0, 4), 10);
        const y1 = parseInt(String(this.horizonDate).slice(0, 4), 10);
        if (Number.isNaN(y0) || Number.isNaN(y1)) return [new Date().getFullYear()];
        const lo = Math.min(y0, y1);
        const hi = Math.max(y0, y1);
        const arr = [];
        for (let y = lo; y <= hi; y++) arr.push(y);
        return arr.length ? arr : [new Date().getFullYear()];
      },
      holidayMapForPeriod() {
        const BH = typeof BrHolidays !== 'undefined' ? BrHolidays : null;
        if (BH && typeof BH.holidayMapBetween === 'function') {
          return BH.holidayMapBetween(this.periodStart, this.horizonDate);
        }
        return {};
      },
      holidaysListForModal() {
        const BH = typeof BrHolidays !== 'undefined' ? BrHolidays : null;
        if (BH && typeof BH.holidayListBetween === 'function') {
          return BH.holidayListBetween(this.periodStart, this.horizonDate);
        }
        return [];
      },
      cofrinhoDailyLedger() {
        if (!this.cofrinhoTaxes) return [];
        return buildCofrinhoDailyLedger(
          this.initialBalance,
          this.flows,
          this.periodStart,
          this.horizonDate,
          this.todayIso,
          this.holidayMapForPeriod,
          this.cdiResolveAnnualRate
        );
      },
      filteredLedgerRows() {
        return this.cofrinhoDailyLedger.filter(
          (r) => r.year === this.ledgerFilterYear && r.month === this.ledgerFilterMonth
        );
      },
      /** Soma da coluna Diff no mês filtrado do extrato. */
      ledgerMonthStatDiffTotal() {
        return this.filteredLedgerRows.reduce((s, r) => s + (r.diff != null ? Number(r.diff) : 0), 0);
      },
      /** Dias em que houve postagem de rendimento (Diff preenchido). */
      ledgerMonthStatDaysWithYield() {
        return this.filteredLedgerRows.filter((r) => r.diff !== null && r.diff !== undefined).length;
      },
      /**
       * Semanas (segunda–domingo) que aparecem no extrato do mês filtrado; em cada uma:
       * média = soma do Diff na semana ÷ dias com Diff naquela semana.
       * @returns {{ weekStartIso: string, weekEndIso: string, sumDiff: number, daysWithYield: number, avgYield: number|null }[]}
       */
      ledgerMonthStatWeekBreakdown() {
        const rows = this.filteredLedgerRows;
        if (!rows.length) return [];
        const byWeek = new Map();
        for (const r of rows) {
          const wk = mondayOfWeekContainingIso(r.dateIso);
          if (!byWeek.has(wk)) {
            byWeek.set(wk, { weekStartIso: wk, sumDiff: 0, daysWithYield: 0 });
          }
          const g = byWeek.get(wk);
          if (r.diff !== null && r.diff !== undefined) {
            g.sumDiff += Number(r.diff);
            g.daysWithYield += 1;
          }
        }
        const list = [...byWeek.values()]
          .map((g) => {
            const weekEndIso = addCalendarDaysIso(g.weekStartIso, 6);
            const avgYield = g.daysWithYield > 0 ? g.sumDiff / g.daysWithYield : null;
            return { ...g, weekEndIso, avgYield };
          })
          .sort((a, b) => a.weekStartIso.localeCompare(b.weekStartIso));
        return list;
      },
      /**
       * Média no mês: soma Diff ÷ apenas dias em que houve Diff (incremento).
       * @returns {number|null}
       */
      ledgerMonthStatAvgYieldOnYieldDays() {
        const ny = this.ledgerMonthStatDaysWithYield;
        if (ny === 0) return null;
        return this.ledgerMonthStatDiffTotal / ny;
      },
      sortedFlows() {
        return [...this.flows].sort((a, b) => a.date.localeCompare(b.date));
      },
      periodStart() {
        const t = this.simulationStart;
        if (!this.flows.length) return t;
        const minD = this.sortedFlows[0].date;
        return minD < t ? minD : t;
      },
      simulation() {
        if (this.cofrinhoTaxes) {
          const o = simulateCofrinho(
            this.initialBalance,
            this.flows,
            this.periodStart,
            this.horizonDate,
            this.holidayMapForPeriod,
            this.cdiResolveAnnualRate
          );
          return {
            finalBalance: o.finalBalance,
            balanceZeroRate: o.balanceZeroRate,
            interestGain: o.finalBalance - o.balanceZeroRate,
            totalGrossYield: o.totalGrossYield,
            totalIof: o.totalIof,
            totalIr: o.totalIr,
            totalNetYield: o.totalNetYield,
            businessDays: o.businessDays,
            mode: 'cofrinho',
          };
        }
        const { finalBalance, balanceZeroRate } = simulateAll(
          this.initialBalance,
          this.flows,
          this.periodStart,
          this.horizonDate,
          this.annualRate,
          this.compounding
        );
        return {
          finalBalance,
          balanceZeroRate,
          interestGain: finalBalance - balanceZeroRate,
          totalGrossYield: null,
          totalIof: null,
          totalIr: null,
          totalNetYield: null,
          businessDays: null,
          mode: 'simple',
        };
      },
      baselineFinal() {
        return this.simulation.finalBalance;
      },
      impactById() {
        const base = this.baselineFinal;
        const map = {};
        for (const f of this.flows) {
          const without = this.flows.filter((x) => x.id !== f.id);
          const ps = this.periodStartWithout(without);
          let finalBalance;
          if (this.cofrinhoTaxes) {
            const hm =
              typeof BrHolidays !== 'undefined' && BrHolidays.holidayMapBetween
                ? BrHolidays.holidayMapBetween(ps, this.horizonDate)
                : {};
            finalBalance = simulateCofrinho(
              this.initialBalance,
              without,
              ps,
              this.horizonDate,
              hm,
              this.cdiResolveAnnualRate
            ).finalBalance;
          } else {
            finalBalance = simulateAll(
              this.initialBalance,
              without,
              ps,
              this.horizonDate,
              this.annualRate,
              this.compounding
            ).finalBalance;
          }
          map[f.id] = base - finalBalance;
        }
        return map;
      },
      incomeHints() {
        const sim = this.simulation;
        if (sim.mode === 'cofrinho' && sim.businessDays > 0) {
          const d = sim.totalNetYield / sim.businessDays;
          return {
            daily: d,
            monthly: d * 21,
            yearly: d * 252,
            netBased: true,
          };
        }
        const B = sim.finalBalance;
        const r = this.annualRate;
        if (B <= 0 || r <= 0) {
          return { daily: 0, monthly: 0, yearly: B * r, netBased: false };
        }
        const daily = B * (Math.pow(1 + r, 1 / 365) - 1);
        const monthly = B * (Math.pow(1 + r, 1 / 12) - 1);
        const yearly = B * r;
        return { daily, monthly, yearly, netBased: false };
      },
      aporteYieldModalTableRows() {
        if (!this.aporteYieldModalFlow || this.aporteYieldModalKind !== 'in') return [];
        const d0 = this.aporteYieldModalFlow.date;
        return this.aporteYieldModalRows.filter((r) => compareIso(r.dateIso, d0) >= 0);
      },
      aporteYieldModalNetTotal() {
        return this.aporteYieldModalTableRows.reduce((s, r) => s + (r.diff !== null && r.diff !== undefined ? Number(r.diff) : 0), 0);
      },
      aporteYieldModalTotalIof() {
        return this.aporteYieldModalTableRows.reduce((s, r) => s + (r.dailyIof != null ? Number(r.dailyIof) : 0), 0);
      },
      aporteYieldModalTotalIr() {
        return this.aporteYieldModalTableRows.reduce((s, r) => s + (r.dailyIr != null ? Number(r.dailyIr) : 0), 0);
      },
    },
    methods: {
      scheduleCdiRefresh() {
        if (!this.cdiSynced) return;
        if (this._cdiRefreshTimer) clearTimeout(this._cdiRefreshTimer);
        this._cdiRefreshTimer = setTimeout(() => {
          this._cdiRefreshTimer = null;
          this.refreshCdiFromBcb();
        }, 350);
      },
      async refreshCdiFromBcb() {
        this.cdiLoading = true;
        this.cdiError = '';
        try {
          if (!this.cdiSynced) {
            const res = await fetch(BCB_CDI_LAST_JSON_URL, { method: 'GET' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rows = await res.json();
            if (!Array.isArray(rows) || rows.length === 0) throw new Error('Resposta vazia');
            const latest = pickLatestSgsRow(rows) || rows[0];
            const pct = parseSgsValor(latest.valor);
            if (Number.isNaN(pct) || pct < 0) throw new Error('Valor inválido');
            this.cdiReferenceDate = typeof latest.data === 'string' ? latest.data : '';
            this.annualRatePercent = Math.round(pct * 10000) / 10000;
            this.cdiSeriesPoints = [];
            this.cdiSeriesFrom = '';
            this.cdiSeriesTo = '';
            return;
          }

          const fromIso = this.periodStart;
          const toIso = this.horizonDate;
          if (!fromIso || !toIso || compareIso(fromIso, toIso) > 0) {
            throw new Error('Intervalo de datas inválido para o CDI');
          }
          const dataInicial = isoToBrDate(fromIso);
          const dataFinal = isoToBrDate(toIso);
          const url = bcbCdiSeriesUrl(dataInicial, dataFinal);
          const res = await fetch(url, { method: 'GET' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const rows = await res.json();
          if (!Array.isArray(rows) || rows.length === 0) throw new Error('Resposta vazia');
          const points = buildSortedCdiPointsFromSgs(rows);
          if (points.length === 0) throw new Error('Nenhum ponto válido na série CDI');
          this.cdiSeriesPoints = points;
          this.cdiSeriesFrom = fromIso;
          this.cdiSeriesTo = toIso;
          const last = points[points.length - 1];
          this.annualRatePercent = Math.round(last.annualDecimal * 100 * 10000) / 10000;
          this.cdiReferenceDate = last.dataBr || this.formatDate(last.dateIso);
        } catch (_e) {
          this.cdiSeriesPoints = [];
          this.cdiSeriesFrom = '';
          this.cdiSeriesTo = '';
          this.cdiError =
            'Não foi possível obter o CDI no Banco Central. Verifique a conexão ou restrições do navegador (CORS) e tente de novo.';
        } finally {
          this.cdiLoading = false;
        }
      },
      saveToStorage() {
        try {
          const payload = {
            simulationStart: this.simulationStart,
            horizonDate: this.horizonDate,
            compounding: this.compounding,
            annualRatePercent: this.annualRatePercent,
            cdiSynced: this.cdiSynced,
            cdiReferenceDate: this.cdiReferenceDate,
            cofrinhoTaxes: this.cofrinhoTaxes,
            ledgerFilterMonth: this.ledgerFilterMonth,
            ledgerFilterYear: this.ledgerFilterYear,
            movementsSectionExpanded: this.movementsSectionExpanded,
            summarySectionExpanded: this.summarySectionExpanded,
            paramsSectionExpanded: this.paramsSectionExpanded,
            incomeSectionExpanded: this.incomeSectionExpanded,
            ledgerSectionExpanded: this.ledgerSectionExpanded,
            initialBalance: this.initialBalance,
            flows: this.flows,
            newFlow: this.newFlow,
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } catch (_) {
          /* quota ou modo privado */
        }
      },
      periodStartWithout(flowList) {
        const t = this.simulationStart;
        if (!flowList.length) return t;
        const sorted = [...flowList].sort((a, b) => a.date.localeCompare(b.date));
        const minD = sorted[0].date;
        return minD < t ? minD : t;
      },
      formatMoney(n) {
        return new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        }).format(Number(n) || 0);
      },
      formatDate(iso) {
        if (!iso) return '—';
        const [y, m, d] = iso.split('-');
        return `${d}/${m}/${y}`;
      },
      formatSignedMoney(n) {
        const v = Number(n) || 0;
        if (v > 0) return `+${this.formatMoney(v)}`;
        return this.formatMoney(v);
      },
      /** CDI anualizado em % a partir do decimal anual (ex.: 0,1415 → 14,15%). */
      formatCdiAnnualPercent(annualDecimal) {
        const n = (Number(annualDecimal) || 0) * 100;
        return new Intl.NumberFormat('pt-BR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        }).format(n);
      },
      /** Percentual efetivo no dia (ex.: IOF sobre bruto, IR sobre base após IOF). */
      formatTaxDayPercent(p) {
        if (p === null || p === undefined || Number.isNaN(Number(p))) return '';
        const n = Number(p);
        return `${new Intl.NumberFormat('pt-BR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        }).format(n)}\u00a0%`;
      },
      /** % diário linear a partir do CDI a.a. em decimal: (CDI a.a. / 252) × 100. O rendimento na simulação usa (1+CDI)^(1/252)−1. */
      formatCdiDailyLinearPercent(annualDecimal) {
        const r = Number(annualDecimal);
        if (Number.isNaN(r)) return '—';
        const pct = (r / 252) * 100;
        return `${new Intl.NumberFormat('pt-BR', {
          minimumFractionDigits: 4,
          maximumFractionDigits: 6,
        }).format(pct)}\u00a0%`;
      },
      clampLedgerYearToRange() {
        const opts = this.ledgerYearOptions;
        if (!opts.length) return;
        if (!opts.includes(this.ledgerFilterYear)) {
          this.ledgerFilterYear = opts[opts.length - 1];
        }
      },
      showMovementYieldModal() {
        const el = document.getElementById('movementYieldModal');
        if (el && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
          bootstrap.Modal.getOrCreateInstance(el).show();
        }
      },
      /** Copia a tabela do modal “Rendimento do aporte” como TSV (colunas = tab, linhas = LF). */
      copyAporteYieldModalTable() {
        const rows = this.aporteYieldModalTableRows;
        if (!rows.length) return;
        const tab = '\t';
        const headers = [
          'Data',
          'Dia',
          'CDI (% a.a. do dia)',
          '% CDI diário (÷ 252)',
          '% IOF (dia)',
          'IOF (dia)',
          '% IR (dia)',
          'IR (dia)',
          'Rendimento líquido do dia (só este aporte)',
          'Saldo do aporte após o dia',
        ];
        const flatCell = (s) => String(s).replace(/\t/g, ' ').replace(/\r\n|\r|\n/g, ' ');
        const bodyLines = rows.map((r) => {
          const dataStr = flatCell(`${this.formatDate(r.dateIso)}${r.projected ? ' (Projeção)' : ''}`);
          const hasIof = r.dailyIof !== null && r.dailyIof !== undefined;
          const hasIr = r.dailyIr !== null && r.dailyIr !== undefined;
          const iofPct = hasIof ? flatCell(this.formatTaxDayPercent(r.dailyIofPct)) : '—';
          const iofAmt = hasIof ? flatCell(this.formatMoney(r.dailyIof)) : '—';
          const irPct = hasIr ? flatCell(this.formatTaxDayPercent(r.dailyIrPct)) : '—';
          const irAmt = hasIr ? flatCell(this.formatMoney(r.dailyIr)) : '—';
          const diffStr =
            r.diff !== null && r.diff !== undefined ? flatCell(this.formatMoney(r.diff)) : '—';
          const saldo = flatCell(this.formatMoney(r.valor));
          const cdiAa = flatCell(this.formatCdiAnnualPercent(r.cdiAnnualDecimal));
          const cdiDia = flatCell(this.formatCdiDailyLinearPercent(r.cdiAnnualDecimal));
          return [
            dataStr,
            flatCell(r.weekday),
            cdiAa,
            cdiDia,
            iofPct,
            iofAmt,
            irPct,
            irAmt,
            diffStr,
            saldo,
          ].join(tab);
        });
        const text = [headers.join(tab), ...bodyLines].join('\n');
        const onCopied = () => {
          if (this._aporteYieldCopyTimer) clearTimeout(this._aporteYieldCopyTimer);
          this.aporteYieldTableCopyOk = true;
          this._aporteYieldCopyTimer = setTimeout(() => {
            this.aporteYieldTableCopyOk = false;
            this._aporteYieldCopyTimer = null;
          }, 2500);
        };
        const fallback = () => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            onCopied();
          } catch (_e) {
            /* sem permissão ou ambiente restrito */
          }
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(onCopied).catch(fallback);
        } else {
          fallback();
        }
      },
      openAporteYieldDetail(meta) {
        if (!this.cofrinhoTaxes) return;
        const flow = this.flows.find((f) => f.id === meta.id);
        if (!flow || flow.amount <= 0) return;
        this.aporteYieldModalKind = 'in';
        this.aporteYieldModalFlow = { ...flow };
        this.aporteYieldModalRows = buildCofrinhoDailyLedger(
          0,
          [flow],
          this.periodStart,
          this.horizonDate,
          this.todayIso,
          this.holidayMapForPeriod,
          this.cdiResolveAnnualRate
        );
        this.$nextTick(() => this.showMovementYieldModal());
      },
      openWithdrawalYieldInfo() {
        if (!this.cofrinhoTaxes) return;
        this.aporteYieldModalKind = 'out';
        this.aporteYieldModalFlow = null;
        this.aporteYieldModalRows = [];
        this.$nextTick(() => this.showMovementYieldModal());
      },
      positiveMovementFlows(row) {
        return (row && row.movementFlows ? row.movementFlows : []).filter((x) => x.amount > 0);
      },
      addFlow() {
        const raw = Number(this.newFlow.amount);
        if (!raw || raw <= 0) return;
        const signed = this.newFlow.kind === 'out' ? -raw : raw;
        this.flows.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random()}`,
          date: this.newFlow.date,
          amount: signed,
          label: this.newFlow.label,
        });
        this.newFlow.label = '';
      },
      removeFlow(id) {
        this.flows = this.flows.filter((f) => f.id !== id);
      },
      exportFlowsJson() {
        const d = dateToIso(new Date()).replace(/-/g, '');
        const payload = {
          exportType: 'financeiro-movimentacoes',
          version: 1,
          exportedAt: new Date().toISOString(),
          flows: this.flows.map(({ date, amount, label }) => ({
            date,
            amount,
            label: label || '',
          })),
        };
        downloadTextFile(`movimentacoes-${d}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
        this.flowsImportMessage = '';
      },
      exportFlowsCsv() {
        const d = dateToIso(new Date()).replace(/-/g, '');
        const esc = (cell) => {
          const s = String(cell ?? '');
          if (s.includes(';') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        };
        const lines = [['data', 'valor', 'descricao'].join(';')];
        for (const f of [...this.flows].sort((a, b) => a.date.localeCompare(b.date))) {
          const val = String(f.amount).replace('.', ',');
          lines.push([esc(f.date), esc(val), esc(f.label || '')].join(';'));
        }
        const bom = '\uFEFF';
        downloadTextFile(`movimentacoes-${d}.csv`, bom + lines.join('\n'), 'text/csv;charset=utf-8');
        this.flowsImportMessage = '';
      },
      triggerImportFlows() {
        this.flowsImportMessage = '';
        const el = this.$refs.importFlowsInput;
        if (el) el.click();
      },
      onImportFlowsFile(event) {
        const file = event.target.files && event.target.files[0];
        const input = event.target;
        if (!file) return;
        this.flowsImportMessage = '';
        const reader = new FileReader();
        const lower = file.name.toLowerCase();
        reader.onload = () => {
          try {
            let list;
            if (lower.endsWith('.json')) {
              list = this.parseFlowsImportJson(reader.result);
            } else {
              list = this.parseFlowsImportCsv(reader.result);
            }
            if (!list.length) {
              this.flowsImportMessage = 'Nenhuma movimentação válida no arquivo.';
              input.value = '';
              return;
            }
            if (!confirm(`Importar ${list.length} movimentação(ões) e substituir as atuais?`)) {
              input.value = '';
              return;
            }
            this.flows = list.map((row) => ({
              id: crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random()}`,
              date: row.date,
              amount: row.amount,
              label: typeof row.label === 'string' ? row.label : '',
            }));
            this.flowsImportMessage = `${list.length} movimentação(ões) importadas.`;
          } catch (_e) {
            this.flowsImportMessage = 'Não foi possível ler o arquivo. Use JSON (exportado aqui) ou CSV com colunas data, valor, descricao.';
          }
          input.value = '';
        };
        reader.onerror = () => {
          this.flowsImportMessage = 'Erro ao abrir o arquivo.';
          input.value = '';
        };
        reader.readAsText(file, 'UTF-8');
      },
      parseFlowsImportJson(text) {
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : data && Array.isArray(data.flows) ? data.flows : null;
        if (!arr) throw new Error('invalid');
        const out = [];
        for (const row of arr) {
          if (!row) continue;
          const ds = typeof row.date === 'string' ? row.date : '';
          const dateNorm = /^\d{4}-\d{2}-\d{2}$/.test(ds) ? ds : parseDateFlexible(ds);
          if (!dateNorm) continue;
          const amt = typeof row.amount === 'number' ? row.amount : parseMoneyFlexible(row.amount);
          if (Number.isNaN(amt) || amt === 0) continue;
          out.push({
            date: dateNorm,
            amount: amt,
            label: typeof row.label === 'string' ? row.label : '',
          });
        }
        out.sort((a, b) => a.date.localeCompare(b.date));
        return out;
      },
      parseFlowsImportCsv(text) {
        const raw = String(text).replace(/^\uFEFF/, '');
        const lines = raw.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) return [];
        const delim = lines[0].includes(';') && !lines[0].includes(',') ? ';' : lines[0].split(';').length > 1 ? ';' : ',';
        const header = lines[0].split(delim).map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
        const idxData = header.findIndex((h) => h === 'data' || h === 'date');
        const idxValor = header.findIndex((h) => h === 'valor' || h === 'amount' || h === 'value');
        const idxDesc = header.findIndex((h) => h === 'descricao' || h === 'label' || h === 'memo' || h === 'historico');
        if (idxData < 0 || idxValor < 0) throw new Error('header');
        const out = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(delim);
          if (cols.length < Math.max(idxData, idxValor) + 1) continue;
          const dateIso = parseDateFlexible(cols[idxData]);
          const amt = parseMoneyFlexible(cols[idxValor]);
          if (!dateIso || Number.isNaN(amt) || amt === 0) continue;
          const label = idxDesc >= 0 && cols[idxDesc] !== undefined ? String(cols[idxDesc]).trim() : '';
          out.push({ date: dateIso, amount: amt, label });
        }
        out.sort((a, b) => a.date.localeCompare(b.date));
        return out;
      },
      monthLabel(m) {
        const names = [
          'Janeiro',
          'Fevereiro',
          'Março',
          'Abril',
          'Maio',
          'Junho',
          'Julho',
          'Agosto',
          'Setembro',
          'Outubro',
          'Novembro',
          'Dezembro',
        ];
        return names[(Number(m) || 1) - 1] || '';
      },
    },
  }).mount('#app');
})();
