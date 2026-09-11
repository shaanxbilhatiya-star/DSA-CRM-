/* ────────────────────────────────────────────────────────────────────────────
   CIBIL CIR ANALYSER

   Reads a TransUnion CIBIL Consumer CIR and produces the deep-analysis summary:
   score and factors, KYC match against the form, active exposure, current
   overdues, guarantor exposure, historical delinquencies, enquiry pattern and
   loan-stacking signals.

   Deliberately a parser and rules engine, not a language model. A CIR is rigidly
   structured, so every figure in the summary is read directly out of the report:
   the same report always yields the same numbers, every figure can be traced back
   to a line in the CIR, it costs nothing and runs offline. A model asked to do
   this can transpose or invent an amount, which is not acceptable when the output
   drives an underwriting decision. Where the report genuinely does not say
   something — whether an enquiry was declined, whether the applicant signed as
   guarantor — the analysis says so instead of inferring it.

   Reads text out of the PDF with pdf.js (already loaded by every form) and out of
   a saved .html/.txt CIR directly. An image scan has no text layer and is
   reported as such rather than guessed at.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // Asset classifications, worst last.
  var CLASS_RANK = { STD: 0, SMA: 1, SUB: 2, DBT: 3, LSS: 4 };

  function num(s) {
    if (s == null) return 0;
    var n = parseFloat(String(s).replace(/[₹,\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function inr(n) {
    if (!n && n !== 0) return '—';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function firstMatch(text, re, group) {
    var m = re.exec(text);
    return m ? String(m[group == null ? 1 : group]).trim() : '';
  }

  // A CIR is laid out in two-column tables. Depending on how the PDF text layer is
  // walked, a label and its value can end up separated by other cells, so a value is
  // looked for within a bounded window after its label rather than immediately after
  // it. `stop` keeps the window from running into the next label.
  function labelled(text, label, valueRe, window) {
    var re = new RegExp(label + '[\\s:]{0,4}([\\s\\S]{0,' + (window || 60) + '})', 'i');
    var m = re.exec(text);
    if (!m) return '';
    var v = valueRe.exec(m[1]);
    return v ? String(v[1]).trim() : '';
  }
  var DATE_RE = /(\d{2}\/\d{2}\/\d{4})/;
  // Dates in the account card, in printed order, stopping before the payment-history
  // block so its START/END DATE values are not mistaken for account dates.
  // Labels that begin the next cell in an account card. A value is cut short at any of
  // them, and at the first colon or digit, so a capture cannot run into its neighbour.
  // "CREDIT" needs a lookahead: it starts the labels "CREDIT FACILITY STATUS" and
  // "HIGH CREDIT AMOUNT", but it also sits in the middle of the account types
  // "KISAN CREDIT CARD" and "SECURED CREDIT CARD", which were being cut down to
  // "KISAN" and "SECURED".
  var NEXT_CELL = /\s+(?:SANCTIONED|CURRENT|HIGH|ACTUAL|COLLATERAL|PAYMENT|REPAYMENT|INTEREST|EMI|OWNERSHIP|MEMBER|ACCOUNT|AMOUNTS?|STATUS|CREDIT(?!\s*CARD)|WRITTEN|SUIT|DAYS|YEAR|NA)\b/i;
  function cleanCell(v) {
    var s2 = String(v == null ? '' : v);
    var cut = s2.search(/[:\d]/);
    if (cut > 0) s2 = s2.slice(0, cut);
    var m = NEXT_CELL.exec(s2);
    if (m) s2 = s2.slice(0, m.index);
    return s2.replace(/[\s\u2013\u2014-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  }

  function datesIn(flat) {
    var head = flat.split(/DAYS PAST DUE|ASSET CLASSIFICATION/i)[0];
    return (head.match(/\d{2}\/\d{2}\/\d{4}/g) || []);
  }
  var MONEY_RE = /\u20b9?\s*([\d,]{2,})/;

  // Reads one money cell. The CIR prints these as "LABEL : ₹ n", or "LABEL : -" when
  // the field is empty.
  //
  // Two things went wrong with reading the first number in a window after the label.
  // MONEY_RE demands two or more characters, so a genuine "₹ 0" was skipped and the
  // search ran on into the NEXT field — a card reading
  // "OVERDUE AMOUNT : ₹ 0  EMI : ₹ 1,92,455" was reported as ₹1,92,455 overdue, which
  // turned a healthy account into a defaulting one. An empty "-" cell did the same.
  // So the value is now taken from immediately after the label's colon, a lone dash
  // reads as zero, and the fallback for odd layouts stops at the next cell label.
  function money(flat, label) {
    var strict = new RegExp(
      label + '(?:\\s*(?:AMOUNT|VALUE))?\\s*:?\\s*(?:\\u20b9\\s*)?([\\d][\\d,]*|[-\\u2013\\u2014])', 'i');
    var m = strict.exec(flat);
    if (m) return /^[-\u2013\u2014]$/.test(m[1]) ? 0 : num(m[1]);
    var w = new RegExp(label + '[\\s:]{0,4}([\\s\\S]{0,40})', 'i').exec(flat);
    if (!w) return 0;
    var seg = w[1];
    var cut = NEXT_CELL.exec(seg);
    if (cut) seg = seg.slice(0, cut.index);
    var v = /\u20b9?\s*([\d][\d,]*)/.exec(seg);
    return v ? num(v[1]) : 0;
  }

  // Which product an account or an enquiry is for, so the two can be compared. Returns
  // '' when the wording is not recognised, which callers treat as "cannot tell".
  function productKey(s) {
    var v = String(s || '').toUpperCase();
    if (/GOLD/.test(v)) return 'GOLD';
    if (/TWO.?WHEEL/.test(v)) return 'TW';
    if (/TRACTOR/.test(v)) return 'TRACTOR';
    if (/KISAN|\bAGRI/.test(v)) return 'AGRI';
    if (/PROPERTY|\bLAP\b/.test(v)) return 'LAP';
    if (/HOUSING|HOME\s*LOAN/.test(v)) return 'HOUSING';
    if (/CREDIT\s*CARD/.test(v)) return 'CARD';
    if (/EDUCAT/.test(v)) return 'EDU';
    if (/AUTO|CAR\s*LOAN|VEHICLE/.test(v)) return 'AUTO';
    if (/BUSINESS|OVERDRAFT|WORKING\s*CAPITAL/.test(v)) return 'BUSINESS';
    if (/CONSUMER/.test(v)) return 'CONSUMER';
    if (/PERSONAL/.test(v)) return 'PERSONAL';
    return '';
  }

  function dmyToDate(s) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  function monthsBetween(a, b) {
    if (!a || !b) return null;
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  /* ── text extraction ─────────────────────────────────────────────────────── */

  function extractText(file) {
    var name = (file && file.name ? file.name : '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(name)) {
      return Promise.reject(new Error('IMAGE'));
    }
    if (/\.(html?|txt)$/.test(name)) {
      return file.text().then(function (t) {
        // A saved CIR is HTML; strip tags but keep block boundaries as newlines.
        return t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
                .replace(/<(br|\/tr|\/p|\/div|\/td|\/th|\/h\d)[^>]*>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
                .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
                .replace(/[ \t]+/g, ' ');
      });
    }
    if (typeof window.pdfjsLib === 'undefined') {
      return Promise.reject(new Error('NO_PDFJS'));
    }
    return file.arrayBuffer().then(function (buf) {
      return window.pdfjsLib.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
    }).then(function (pdf) {
      var pages = [];
      for (var i = 1; i <= pdf.numPages; i++) pages.push(i);
      return pages.reduce(function (chain, n) {
        return chain.then(function (acc) {
          return pdf.getPage(n).then(function (page) {
            return page.getTextContent();
          }).then(function (tc) {
            // Group items into lines by vertical position so table rows survive.
            // Group into visual lines with a small vertical tolerance and order each
            // line left to right. Rounding y to whole units split a table row whose
            // cells sat a fraction apart, which detached labels from their values.
            var buckets = [];
            tc.items.forEach(function (it) {
              var y = (it.transform ? it.transform[5] : 0) * -1;
              var x = it.transform ? it.transform[4] : 0;
              var b = null;
              for (var i = 0; i < buckets.length; i++) {
                if (Math.abs(buckets[i].y - y) <= 3) { b = buckets[i]; break; }
              }
              if (!b) { b = { y: y, cells: [] }; buckets.push(b); }
              b.cells.push({ x: x, s: it.str });
            });
            buckets.sort(function (p, q) { return p.y - q.y; });
            var lines = buckets.map(function (b) {
              return b.cells.sort(function (p, q) { return p.x - q.x; })
                .map(function (c) { return c.s; }).join(' ').replace(/\s+/g, ' ').trim();
            }).filter(function (l) { return l.length; });
            return acc + lines.join('\n') + '\n';
          });
        });
      }, Promise.resolve(''));
    });
  }

  /* ── parsing ─────────────────────────────────────────────────────────────── */

  function parseConsumer(text) {
    // The CONSUMER DETAILS strip prints name, DOB, gender and score on one line, which
    // survives any column interleaving. The header table is only a fallback, and the
    // name there is rejected if it looks like a neighbouring label rather than a name.
    var line = firstMatch(text, /CONSUMER\s*NAME\s*:\s*(.{2,120}?)\s+D\.?O\.?B\.?\s*:/i);
    var endOf = firstMatch(text, /END OF REPORT ON\s+(.{2,120}?)\s*$/im);
    var header = firstMatch(text, /CONSUMER\s*NAME\s*:\s*([^\n]{2,120})/i);
    function looksLikeName(v) {
      if (!v) return false;
      if (/^(PAN|DOB|GENDER|ADDRESS|TELEPHONE|EMAIL|CKYC|VOTER|PASSPORT|DRIVING|AADHAAR|G RAM G)\b/i.test(v)) return false;
      return /[A-Za-z]{3}/.test(v);
    }
    var name = [line, endOf, header].filter(looksLikeName)[0] || '';
    return {
      name: name.replace(/\s{2,}/g, ' ').trim(),
      dob: firstMatch(text, /\bD\.?O\.?B\.?\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i),
      gender: firstMatch(text, /\bGENDER\s*:?\s*(Male|Female|Transgender|Other)\b/i),
      pan: firstMatch(text, /\bPAN(?:\s*CARD)?\s*:\s*([A-Z]{5}\d{4}[A-Z])/i),
      reportDate: firstMatch(text, /REPORT DATE\s*&?\s*TIME\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
      control: firstMatch(text, /CONTROL NUMBER\s*:\s*(\d+)/i)
    };
  }

  function parseScores(text) {
    // Every gauge prints its number right after the 300..900 scale, so the gauges are
    // collected in order instead of being matched by position relative to a heading.
    var gauges = [];
    var g = /300\s*900\s*(\d{3})/g, gm;
    while ((gm = g.exec(text)) !== null) {
      var v = parseInt(gm[1], 10);
      if (v >= 300 && v <= 900) gauges.push(v);
    }
    var labelled_cv = firstMatch(text, /CREDITVISION\s*(?:®|\(R\))?\s*SCORE\s*:\s*(\d{3})/i);
    var cv = labelled_cv ? parseInt(labelled_cv, 10) : (gauges.length ? gauges[0] : null);
    var pl = null;
    for (var i = 0; i < gauges.length; i++) { if (gauges[i] !== cv) { pl = gauges[i]; break; } }
    if (pl == null && gauges.length > 1) pl = gauges[1];

    // Each gauge has its own SCORING FACTORS list; they are kept apart so the reader
    // can see which score a factor belongs to.
    var groups = [];
    var re = /SCORING FACTORS([\s\S]{0,500}?)(?=SCORING FACTORS|CONSUMER ACCOUNT SUMMARY|ACCOUNTS\s|TOTAL ENQUIRIES|CREDITVISION\u00ae ALGORITHM|CONSUMER DETAILS|$)/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var list = [];
      m[1].split(/\n|(?=\d\.\s)/).forEach(function (l) {
        var f = /^\s*\d+\.\s*([A-Za-z][^\n]{4,120}?)\s*$/.exec(l.trim());
        if (f && list.indexOf(f[1]) === -1) list.push(f[1]);
      });
      if (list.length) groups.push(list);
    }
    var flat = [];
    groups.forEach(function (l) { l.forEach(function (f) { if (flat.indexOf(f) === -1) flat.push(f); }); });
    return {
      score: cv, plScore: pl, gauges: gauges,
      factorGroups: groups, factors: flat
    };
  }

  function parseEnquirySummary(text) {
    var m = /TOTAL ENQUIRIES\s+MOST RECENT\s+PAST 30 DAYS\s+PAST 12 MONTHS\s+PAST 24 MONTHS\s*\n?\s*(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+(\d+)\s+(\d+)/i.exec(text);
    if (!m) return { total: null, recent: '', d30: null, m12: null, m24: null };
    return { total: +m[1], recent: m[2], d30: +m[3], m12: +m[4], m24: +m[5] };
  }

  function parseEnquiries(text) {
    var start = text.search(/CONSUMER ENQUIRY DETAILS/i);
    if (start === -1) return [];
    var block = text.slice(start).split(/GLOSSARY|CIR DATA GLOSSARY/i)[0];
    var out = [];
    block.split('\n').forEach(function (line) {
      var m = /^\s*(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+₹\s*([\d,]+)\s*$/.exec(line);
      if (!m) return;
      if (/MEMBER NAME/i.test(m[1])) return;
      out.push({ lender: m[1].trim(), date: m[2], purpose: m[3].trim(), amount: num(m[4]) });
    });
    return out;
  }

  // Reads the month grid and returns the worst numeric DPD and worst classification.
  function parseDpdGrid(block) {
    var peak = 0, worstClass = null, worstWhen = '', peakWhen = '';
    var lastReported = '';
    var months = 0;
    block.split('\n').forEach(function (line) {
      var m = /^\s*(\d{4})\s+(.+)$/.exec(line.replace(/\s+/g, ' ').trim());
      if (!m) return;
      var year = m[1];
      var cells = m[2].trim().split(/\s+/);
      if (cells.length < 6) return;                 // not a 12-month row
      cells.slice(0, 12).forEach(function (c, i) {
        var mon = MONTHS[i] + '/' + year;
        if (/^\d{3}$/.test(c)) {
          var d = parseInt(c, 10);
          if (d > 0) { months++; if (d > peak) { peak = d; peakWhen = mon; } }
          if (!lastReported) lastReported = mon;
        } else if (CLASS_RANK[c] != null) {
          if (!lastReported) lastReported = mon;
          if (c !== 'STD' && (worstClass == null || CLASS_RANK[c] > CLASS_RANK[worstClass])) {
            worstClass = c; worstWhen = mon;
          }
        }
      });
    });
    return { peakDpd: peak, peakWhen: peakWhen, worstClass: worstClass, worstWhen: worstWhen,
             monthsDelinquent: months, latestReported: lastReported };
  }

  function parseAccounts(text) {
    var body = text.split(/CONSUMER ENQUIRY DETAILS/i)[0];
    var detail = body.split(/CONSUMER ACCOUNT DETAILS/i);
    body = detail.length > 1 ? detail.slice(1).join(' ') : body;

    // Split on the "1. ACCOUNT" / "2. ACCOUNT" headings rather than on
    // "ACCOUNT INFORMATION". The ACTIVE / INACTIVE badge is drawn in the corner of the
    // card and can be emitted just BEFORE the words "ACCOUNT INFORMATION", so cutting
    // there handed each account the previous account's badge — or none at all, which
    // is why every account was reported as closed.
    var chunks = body.split(/(?:^|\n)\s*\d{1,2}\s*\.\s*ACCOUNT\s*(?=\n|$)/i).slice(1);
    if (chunks.length < 2) chunks = body.split(/ACCOUNT INFORMATION/i).slice(1);
    return chunks.map(function (raw, idx) {
      var block = raw.split(/GLOSSARY/i)[0];
      var flat = block.replace(/\s+/g, ' ');
      var flat0 = block.replace(/\s+/g, ' ');
      var grid = parseDpdGrid(block);
      var writtenOff = money(flat0, 'WRITTEN\\s*OFF\\s*\\(TOTAL\\)');
      var writtenOffPr = money(flat0, 'WRITTEN\\s*OFF\\s*\\(PRINCIP(?:LE|AL)\\)');
      var settled = money(flat0, 'SETTL(?:ED|EMENT)');
      return {
        index: idx + 1,
        // Whether an account is live is taken from DATE CLOSED, which is only filled in
        // once an account closes. The ACTIVE / INACTIVE badge sits in a corner of the
        // table and does not reliably land next to this text, which is why keying off
        // the badge reported every account as closed.
        active: (function () {
          // "INACTIVE" contains "ACTIVE" but not at a word boundary, so the two are
          // distinguishable. The badge is authoritative when present.
          if (/\bINACTIVE\b/i.test(flat)) return false;
          if (/\bACTIVE\b/i.test(flat)) return true;
          return !datesIn(flat)[1];        // no badge: a second date means it closed
        })(),
        type: cleanCell(labelled(flat, '(?:ACCOUNT\\s*)?TYPE', /:?\s*([A-Za-z][A-Za-z\s()\u2013\u2014\/-]{2,60})/, 80)),
        lender: cleanCell(labelled(flat, 'MEMBER\\s*NAME', /:?\s*([A-Za-z][A-Za-z .&\u2013\u2014-]{1,50})/, 70)),
        ownership: (labelled(flat, 'OWNERSHIP', /([A-Z]{4,12})/, 40) || '').toUpperCase(),
        // When the three date labels are emitted together and their values follow as a
        // run, a window after each label finds the wrong one. The CIR always prints
        // them in the order opened, closed, reported, so the dates present in the block
        // are used positionally as a fallback.
        opened: (function () {
          var v = labelled(flat, 'DATE\\s*OPENED', DATE_RE, 24);
          return v || datesIn(flat)[0] || '';
        })(),
        closed: (function () {
          if (/\bINACTIVE\b/i.test(flat) === false && /\bACTIVE\b/i.test(flat)) return '';
          var ds = datesIn(flat);
          return ds.length > 1 ? ds[1] : '';
        })(),
        reported: labelled(flat, 'DATE\\s*REPORTED', DATE_RE, 60) || (datesIn(flat)[2] || ''),
        sanctioned: money(flat, 'SANCTIONED\\s*AMOUNT') || money(flat, 'HIGH\\s*CREDIT'),
        balance: money(flat, 'CURRENT\\s*BALANCE'),
        overdue: money(flat, 'OVERDUE'),
        emi: money(flat, 'EMI'),
        frequency: (labelled(flat, 'PAYMENT\\s*FREQUENCY', /([A-Z-]{5,12})/, 40) || '').toUpperCase(),
        collateralType: firstMatch(flat, /COLLATERAL\s*TYPE\s*:\s*([A-Z ]+?)(?:\s+STATUS|\s+PAYMENT|$)/i),
        // Bounded, and stopped by whatever field follows — the value itself can wrap
        // across lines ("RESTRUCTURED DUE TO" / "COVID-19"), so it cannot simply be
        // read to end of line, but left unbounded it swallows the DPD grid.
        facilityStatus: firstMatch(flat, /CREDIT\s*FACILITY\s*STATUS\s*:\s*([A-Z0-9 \-–]{3,40}?)\s*(?=\s(?:WRITTEN|SUIT|DAYS|YEAR|ACCOUNT|\d{4}\s)|$)/i),
        // "SUIT FILED / WILFUL DEFAULT" is a field LABEL, and the CIR prints it on
        // every account card whether or not a suit exists. Testing the whole card for
        // those words therefore marked EVERY account as suit-filed, which by itself
        // rated a spotless report as red. Only the value beside the label counts, and
        // an empty or negative value reads as no suit.
        suitFiled: (function () {
          var lab = /SUIT\s*-?\s*FILED\s*[\/&]?\s*WIL+FUL\s*DEFAULT\s*:?\s*/i.exec(flat);
          if (!lab) return /SUIT\s*-?\s*FILED|WIL+FUL\s*DEFAULT/i.test(flat);
          var at = lab.index + lab[0].length;
          var val = flat.slice(at, at + 40);
          var cut = NEXT_CELL.exec(val);
          if (cut) val = val.slice(0, cut.index);
          if (/\bNO\b|\bNIL\b|NOT\s*APPLICABLE/i.test(val)) return false;
          return /SUIT\s*-?\s*FILED|WIL+FUL\s*DEFAULT/i.test(val);
        })(),
        writtenOff: writtenOff || writtenOffPr,
        settled: settled,
        dpd: grid
      };
    }).filter(function (a) { return a.type || a.lender || a.sanctioned || a.balance; });
  }

  /* ── analysis ────────────────────────────────────────────────────────────── */

  function analyse(text, applicant) {
    applicant = applicant || {};
    var consumer = parseConsumer(text);
    var scores = parseScores(text);
    var accounts = parseAccounts(text);
    var enquiries = parseEnquiries(text);
    var enqSummary = parseEnquirySummary(text);

    var active = accounts.filter(function (a) { return a.active; });
    var closed = accounts.filter(function (a) { return !a.active; });
    var zeroBalance = accounts.filter(function (a) { return a.balance === 0; });

    // A gold or on-demand facility reports a bullet/maturity figure in the EMI field —
    // one report shows EMI 63,744 against a 58,400 sanction — so those are excluded
    // from the monthly EMI total and shown as interest-only exposure instead.
    function isInterestOnly(a) {
      return /GOLD|KISAN|OVERDRAFT|CASH\s*CREDIT/i.test(a.type || '') ||
             /ON-?DEMAND|BULLET/i.test(a.frequency || '');
    }
    var totalActiveEmi = active.reduce(function (s, a) {
      return s + (isInterestOnly(a) ? 0 : (a.emi || 0));
    }, 0);
    var totalOutstanding = active.reduce(function (s, a) { return s + (a.balance || 0); }, 0);
    var totalSanctioned = accounts.reduce(function (s, a) { return s + (a.sanctioned || 0); }, 0);

    // Gold / on-demand facilities carry no amortising EMI, so they are called out
    // separately rather than being folded into the EMI total.
    var interestOnly = active.filter(isInterestOnly);

    // KYC comparison against what the agent typed on the form.
    var kyc = { nameMatch: null, dobMatch: null, genderMatch: null, notes: [] };
    function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z]/g, ''); }
    if (applicant.name && consumer.name) {
      var a1 = norm(applicant.name), a2 = norm(consumer.name);
      kyc.nameMatch = a2.indexOf(a1) !== -1 || a1.indexOf(a2) !== -1;
      if (!kyc.nameMatch) kyc.notes.push('Form name "' + applicant.name + '" does not match bureau name "' + consumer.name + '" — confirm spelling against PAN before submission.');
    }
    if (applicant.dob && consumer.dob) {
      kyc.dobMatch = applicant.dob === consumer.dob;
      if (!kyc.dobMatch) kyc.notes.push('Form DOB ' + applicant.dob + ' differs from bureau DOB ' + consumer.dob + ' — one of the two is wrong; correct before filing.');
    }
    if (applicant.gender && consumer.gender) {
      kyc.genderMatch = norm(applicant.gender) === norm(consumer.gender);
      if (!kyc.genderMatch) kyc.notes.push('Gender on the form does not match the bureau record.');
    }
    if (applicant.pan && consumer.pan && norm(applicant.pan) !== norm(consumer.pan)) {
      kyc.notes.push('PAN on the form does not match the PAN on the report — the report may belong to a different person.');
    }

    // Current overdues / defaults.
    var overdues = accounts.filter(function (a) {
      return a.overdue > 0 || a.writtenOff > 0 || a.settled > 0 || a.suitFiled ||
             /WRITTEN|SETTL|DOUBTF|LOSS|SUB-?STANDARD/i.test(a.facilityStatus || '') ||
             (a.active && a.dpd.peakDpd >= 90) ||
             (a.dpd.worstClass && CLASS_RANK[a.dpd.worstClass] >= CLASS_RANK.SUB);
    });

    // Serious delinquency with no settlement/write-off reported yet: still curable.
    var curable = overdues.filter(function (a) {
      var serious = a.dpd.peakDpd >= 90 || (a.dpd.worstClass && CLASS_RANK[a.dpd.worstClass] >= CLASS_RANK.SUB);
      return serious && !a.writtenOff && !a.settled;
    });

    // Guarantor exposure gets its own section: a guaranteed facility can affect
    // underwriting even though the applicant was not the primary borrower.
    var guarantor = accounts.filter(function (a) { return a.ownership === 'GUARANTOR'; });

    // Historical delinquency, worst first, short by design.
    var history = accounts.filter(function (a) {
      return a.dpd.peakDpd > 0 || (a.dpd.worstClass && a.dpd.worstClass !== 'STD');
    }).map(function (a) {
      return {
        lender: a.lender || 'Not disclosed', type: a.type,
        peakDpd: a.dpd.peakDpd, when: a.dpd.peakWhen || a.dpd.worstWhen,
        worstClass: a.dpd.worstClass, months: a.dpd.monthsDelinquent,
        outcome: a.writtenOff ? 'Written-off' : a.settled ? 'Settled'
               : a.active ? (a.overdue > 0 ? 'Currently overdue' : 'Running') : 'Closed'
      };
    }).sort(function (x, y) { return y.peakDpd - x.peakDpd; });

    // "NOT DISCLOSED" means the member chose not to be named, not that several
    // accounts share one lender. Counting it as a single lender made three unrelated
    // accounts look like repeated trouble with one bank.
    function namedLender(l) { return l && !/^not\s*disclosed$/i.test(l.trim()); }
    var lendersWithStress = {};
    var unnamedStress = 0;
    history.forEach(function (h) {
      if (h.peakDpd < 30) return;
      if (namedLender(h.lender)) lendersWithStress[h.lender.toUpperCase()] = 1;
      else unnamedStress++;
    });
    var stressLenders = Object.keys(lendersWithStress).length + unnamedStress;
    var pattern = history.length === 0 ? 'Clean repayment record'
      : history.filter(function (h) { return h.peakDpd >= 30; }).length <= 1 ? 'One-off'
      : stressLenders > 1 ? 'Multi-lender stress' : 'Repeated with the same lender';

    // Enquiries with no tradeline opened near the same date. Deliberately not
    // called a rejection: an enquiry can vanish for other reasons.
    var unmatched = enquiries.filter(function (e) {
      var ed = dmyToDate(e.date);
      if (!ed) return false;
      var ek = productKey(e.purpose);
      return !accounts.some(function (a) {
        var od = dmyToDate(a.opened);
        if (!od) return false;
        var gap = monthsBetween(ed, od);
        // `|| 99` here treated a perfect same-month match as no match, because
        // monthsBetween returns 0 and 0 is falsy — an enquiry that plainly resulted in
        // a disbursed loan was still being reported as having no matching tradeline.
        if (gap === null || gap === undefined) return false;
        if (Math.abs(gap) > 2) return false;
        // Date alone is not enough. Matching on the month only, a ₹15,00,000 personal
        // loan enquiry was paired with a ₹58,400 gold loan that happened to open the
        // same month, so five declined applications were reported as funded. The
        // product has to agree, and the sanction has to be in the same league as the
        // amount applied for — a lender may cut the ticket, but not by 25×.
        var ak = productKey(a.type);
        if (ek && ak && ek !== ak) return false;
        if (e.amount > 0 && a.sanctioned > 0) {
          var ratio = a.sanctioned / e.amount;
          if (ratio < 0.1 || ratio > 4) return false;
        }
        return true;
      });
    });
    var reportDate = dmyToDate(consumer.reportDate) || new Date();
    var enq3 = enquiries.filter(function (e) {
      var d = dmyToDate(e.date); return d && monthsBetween(d, reportDate) <= 3;
    }).length;
    var enq6 = enquiries.filter(function (e) {
      var d = dmyToDate(e.date); return d && monthsBetween(d, reportDate) <= 6;
    }).length;

    // Repeat applications while something is already overdue.
    var hasLiveOverdue = accounts.some(function (a) { return a.active && a.overdue > 0; });

    // Stacking: the same lender appearing repeatedly with small, close-together loans.
    var byLender = {};
    accounts.forEach(function (a) {
      if (!namedLender(a.lender)) return;   // cannot attribute an unnamed member
      var k = a.lender.toUpperCase();
      (byLender[k] = byLender[k] || []).push(a);
    });
    var stacking = Object.keys(byLender).map(function (k) {
      var list = byLender[k];
      var dates = list.map(function (a) { return dmyToDate(a.opened); }).filter(Boolean)
                      .sort(function (a, b) { return a - b; });
      var span = dates.length > 1 ? monthsBetween(dates[0], dates[dates.length - 1]) : null;
      var avg = list.reduce(function (s, a) { return s + (a.sanctioned || 0); }, 0) / list.length;
      return { lender: k, count: list.length, spanMonths: span, avgTicket: avg };
    }).filter(function (s) { return s.count >= 3 && s.spanMonths != null && s.spanMonths <= 36; })
      .sort(function (a, b) { return b.count - a.count; });

    // Several facilities opened close together is a stacking signal in its own right,
    // even when no single lender repeats.
    var openDates = accounts.map(function (a) { return dmyToDate(a.opened); })
                            .filter(Boolean).sort(function (x, y) { return x - y; });
    var burst = null;
    for (var bi = 0; bi + 2 < openDates.length; bi++) {
      var win = monthsBetween(openDates[bi], openDates[bi + 2]);
      if (win != null && win <= 12) {
        var n = 3;
        while (bi + n < openDates.length && monthsBetween(openDates[bi], openDates[bi + n]) <= 12) n++;
        burst = { count: n, months: monthsBetween(openDates[bi], openDates[bi + n - 1]) || 0,
                  from: openDates[bi] };
        break;
      }
    }

    var flags = [];
    if (scores.score != null && scores.score < 650) flags.push('Score below 650');
    if (overdues.length) flags.push(overdues.length + ' account(s) with overdue / default markers');
    if (guarantor.length) flags.push(guarantor.length + ' guarantor-linked account(s)');
    if (enq3 >= 5) flags.push(enq3 + ' enquiries in the last 3 months');
    if (stacking.length) flags.push('Repeat borrowing pattern with ' + stacking[0].lender);
    else if (burst) flags.push(burst.count + ' facilities opened within ' + (burst.months || 0) + ' month(s)');
    if (kyc.notes.length) flags.push('KYC mismatch against the form');

    var severe = overdues.some(function (a) {
      return a.writtenOff > 0 || a.settled > 0 || a.suitFiled ||
             (a.dpd.worstClass && CLASS_RANK[a.dpd.worstClass] >= CLASS_RANK.DBT) ||
             (a.active && a.dpd.peakDpd >= 90);
    });
    // A heavy past delinquency still matters even once the account is closed and
    // nothing is currently overdue, and so does any live DPD however small. Judging
    // only on present overdues rated a file with a 393-day history as healthy.
    var pastSevere = history.some(function (h) { return h.peakDpd >= 90; });
    var liveDpd = active.some(function (a) { return a.dpd.peakDpd > 0 || a.overdue > 0; });
    var verdict = severe ? 'red'
      : (overdues.length || pastSevere || liveDpd || kyc.notes.length ||
         (scores.score != null && scores.score < 700) || enq3 >= 5) ? 'amber'
      : 'green';

    return {
      generatedAt: new Date().toISOString(),
      consumer: consumer, scores: scores, kyc: kyc, verdict: verdict, flags: flags,
      exposure: {
        totalAccounts: accounts.length, active: active.length, closed: closed.length,
        zeroBalance: zeroBalance.length, totalActiveEmi: totalActiveEmi,
        totalOutstanding: totalOutstanding, totalSanctioned: totalSanctioned,
        interestOnly: interestOnly.reduce(function (s, a) { return s + (a.balance || 0); }, 0)
      },
      activeAccounts: active, overdues: overdues, curable: curable,
      guarantor: guarantor, history: history.slice(0, 8), pattern: pattern, burst: burst,
      enquiries: { total: enqSummary.total != null ? enqSummary.total : enquiries.length,
                   recent: enqSummary.recent, last3: enq3, last6: enq6,
                   unmatched: unmatched.slice(0, 5), hasLiveOverdue: hasLiveOverdue },
      stacking: stacking.slice(0, 3)
    };
  }

  /* ── rendering ───────────────────────────────────────────────────────────── */

  var DOT = { green: '🟢', amber: '🟠', red: '🔴' };

  function tick(v) { return v === null ? '—' : v ? '✅ Match' : '⚠️ Mismatch'; }

  function renderHtml(a) {
    if (!a) return '';
    var h = [];
    var band = a.verdict === 'red' ? '#fef2f2' : a.verdict === 'amber' ? '#fffbeb' : '#f0fdf4';
    var edge = a.verdict === 'red' ? '#f87171' : a.verdict === 'amber' ? '#fbbf24' : '#86efac';

    h.push('<div class="cibil-analysis" style="margin-top:12px;border:2px solid ' + edge +
      ';border-radius:12px;overflow:hidden;background:#fff">');
    h.push('<div style="padding:13px 15px;background:' + band + '">' +
      '<div style="font-size:14px;font-weight:800;color:#111827">' + DOT[a.verdict] +
      ' CIBIL deep analysis</div>' +
      '<div style="font-size:11.5px;color:#4b5563;margin-top:3px">Read directly from the uploaded report' +
      (a.consumer.reportDate ? ' dated ' + esc(a.consumer.reportDate) : '') +
      (a.consumer.control ? ' · control ' + esc(a.consumer.control) : '') + '</div></div>');
    h.push('<div style="padding:14px 15px;font-size:12.5px;color:#111827;line-height:1.65">');

    // 1. Start here
    h.push('<div style="font-weight:800;margin-bottom:5px">1 · Start here</div>');
    h.push('<div>CreditVision score: <strong style="font-size:15px">' +
      (a.scores.score == null ? '—' : a.scores.score) + '</strong>' +
      (a.scores.plScore ? ' &nbsp;·&nbsp; Personal-loan score: <strong style="font-size:15px">' +
        a.scores.plScore + '</strong>' : '') + '</div>');
    var groups = (a.scores.factorGroups && a.scores.factorGroups.length)
      ? a.scores.factorGroups : (a.scores.factors.length ? [a.scores.factors] : []);
    if (groups.length) {
      h.push('<div style="margin-top:3px">Score factors, in the bureau\'s own wording:</div>');
      groups.forEach(function (list, gi) {
        var who = groups.length > 1
          ? (gi === 0 ? 'CreditVision' + (a.scores.score ? ' (' + a.scores.score + ')' : '')
                      : 'Personal loan' + (a.scores.plScore ? ' (' + a.scores.plScore + ')' : ''))
          : '';
        h.push('<div style="margin-top:2px">' + (who ? '<em>' + esc(who) + '</em>' : '') +
          '<ul style="margin:2px 0 0 18px;padding:0">' +
          list.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>');
      });
    }
    h.push('<div style="margin-top:4px">Name / DOB / Gender: ' + tick(a.kyc.nameMatch) + ' / ' +
      tick(a.kyc.dobMatch) + ' / ' + tick(a.kyc.genderMatch) + '</div>');
    if (a.kyc.notes.length) {
      h.push('<ul style="margin:3px 0 0 18px;padding:0;color:#b45309">' +
        a.kyc.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>');
    }
    h.push('<div style="margin-top:4px">Overall credit profile: <strong>' + DOT[a.verdict] + ' ' +
      (a.verdict === 'red' ? 'High risk' : a.verdict === 'amber' ? 'Needs attention' : 'Healthy') + '</strong></div>');

    // 2. Active exposure
    h.push('<div style="font-weight:800;margin:12px 0 5px">2 · Active loans &amp; current exposure</div>');
    if (a.activeAccounts.length) {
      h.push('<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11.5px">' +
        '<tr style="background:#f3f4f6;text-align:left">' +
        ['Lender', 'Type', 'Sanctioned', 'Outstanding', 'EMI', 'Status'].map(function (c) {
          return '<th style="padding:5px 7px;border:1px solid #e5e7eb;white-space:nowrap">' + c + '</th>';
        }).join('') + '</tr>');
      a.activeAccounts.forEach(function (x) {
        var st = x.overdue > 0 ? '🔴 overdue ' + inr(x.overdue)
               : x.dpd.worstClass && x.dpd.worstClass !== 'STD' ? '🟠 ' + x.dpd.worstClass
               : '🟢 regular';
        h.push('<tr>' + [esc(x.lender || 'Not disclosed'), esc(x.type || '—'), inr(x.sanctioned),
          inr(x.balance), x.emi ? inr(x.emi) : '—', st].map(function (c) {
            return '<td style="padding:5px 7px;border:1px solid #e5e7eb">' + c + '</td>';
          }).join('') + '</tr>');
      });
      h.push('</table></div>');
    } else {
      h.push('<div style="color:#6b7280">No active accounts found in the report.</div>');
    }
    h.push('<div style="margin-top:5px">Active accounts: <strong>' + a.exposure.active +
      '</strong> &nbsp;·&nbsp; Zero-balance / closed: <strong>' + a.exposure.closed +
      '</strong> &nbsp;·&nbsp; Total active EMI: <strong>' + inr(a.exposure.totalActiveEmi) +
      '</strong>' + (a.exposure.interestOnly ? ' &nbsp;·&nbsp; Gold / interest-only exposure: <strong>' +
      inr(a.exposure.interestOnly) + '</strong>' : '') + '</div>');

    // 3. Overdues
    h.push('<div style="font-weight:800;margin:12px 0 5px">3 · Current overdues / defaults</div>');
    if (!a.overdues.length) {
      h.push('<div style="color:#15803d">🟢 No overdue, settled or written-off account reported.</div>');
    } else {
      a.overdues.forEach(function (x) {
        h.push('<div>🔴 <strong>' + esc(x.lender || 'Not disclosed') + '</strong> — ' + esc(x.type || '') +
          ' | worst DPD: ' + (x.dpd.peakDpd || (x.dpd.worstClass || '—')) +
          ' | overdue: ' + (x.overdue ? inr(x.overdue) : 'Blank') +
          ' | EMI: ' + (x.emi ? inr(x.emi) : '—') +
          ' | settlement: ' + (x.settled ? inr(x.settled) : 'Blank') +
          ' | written-off: ' + (x.writtenOff ? inr(x.writtenOff) : 'Blank') +
          (x.suitFiled ? ' | <strong>SUIT FILED</strong>' : '') +
          (x.facilityStatus ? ' | ' + esc(x.facilityStatus) : '') +
          ' | months affected: ' + (x.dpd.monthsDelinquent || 0) +
          ' | latest reported: ' + esc(x.dpd.latestReported || x.reported || '—') + '</div>');
      });
      if (a.curable.length) {
        h.push('<div style="margin-top:6px;padding:9px 11px;background:#fffbeb;border:1.5px solid #fbbf24;' +
          'border-radius:9px;color:#92400e"><strong>⚠️ Priority action:</strong> ' + a.curable.length +
          ' account(s) show serious delinquency but no settlement or write-off has been reported yet. ' +
          'Where full repayment is possible, regularise or close before such a status is reported.</div>');
      }
    }

    // 4. Guarantor
    h.push('<div style="font-weight:800;margin:12px 0 5px">4 · Guarantor / guarantee exposure</div>');
    if (!a.guarantor.length) {
      h.push('<div style="color:#6b7280">No account is reported with GUARANTOR ownership.</div>');
    } else {
      a.guarantor.forEach(function (x) {
        var bad = x.writtenOff || x.settled || x.suitFiled || x.overdue > 0 ||
                  (x.dpd.worstClass && CLASS_RANK[x.dpd.worstClass] >= CLASS_RANK.SUB);
        h.push('<div>' + (bad ? '🔴' : '🟠') + ' <strong>' + esc(x.lender || 'Not disclosed') + '</strong> — ' +
          esc(x.type || '') + ' | outstanding: ' + inr(x.balance) +
          ' | EMI: ' + (x.emi ? inr(x.emi) : '—') +
          ' | worst DPD: ' + (x.dpd.peakDpd || (x.dpd.worstClass || '—')) +
          ' | settlement: ' + (x.settled ? inr(x.settled) : 'Blank') +
          ' | written-off: ' + (x.writtenOff ? inr(x.writtenOff) : 'Blank') +
          ' | status: ' + (x.active ? 'Active' : 'Closed') + '</div>');
      });
      h.push('<div style="margin-top:6px;padding:9px 11px;background:#eff6ff;border:1.5px solid #93c5fd;' +
        'border-radius:9px;color:#1e3a8a">A guaranteed facility can affect underwriting even though the ' +
        'applicant is not the primary borrower. The CIR shows ownership as GUARANTOR but does not name the ' +
        'borrower — verify the account relationship in the CIR and obtain the loan documents or a lender ' +
        'confirmation before relying on it.' +
        (a.guarantor.some(function (x) { return x.writtenOff || x.settled || x.suitFiled; })
          ? ' <strong>One or more guaranteed accounts are settled / written off / suit filed — treat as a major credit-risk issue.</strong>' : '') +
        '</div>');
    }

    // 5. History
    h.push('<div style="font-weight:800;margin:12px 0 5px">5 · Historical delinquencies</div>');
    if (!a.history.length) {
      h.push('<div style="color:#15803d">🟢 No delinquency reported in the payment history.</div>');
    } else {
      a.history.forEach(function (x) {
        var dot = x.peakDpd >= 90 || /Written|Settled/.test(x.outcome) ? '🔴' : x.peakDpd >= 60 ? '🟠' : '🟡';
        h.push('<div>' + dot + ' ' + esc(x.lender) + ' — peak DPD: ' +
          (x.peakDpd || x.worstClass || '—') + ' — period: ' + esc(x.when || '—') +
          ' — ' + esc(x.outcome) + '</div>');
      });
      h.push('<div style="margin-top:4px">Pattern: <strong>' + esc(a.pattern) + '</strong></div>');
    }

    // 6. Enquiries
    h.push('<div style="font-weight:800;margin:12px 0 5px">6 · Enquiry / rejection pattern</div>');
    h.push('<div>Total enquiries: <strong>' + (a.enquiries.total == null ? '—' : a.enquiries.total) +
      '</strong> &nbsp;·&nbsp; last 3 months: <strong>' + a.enquiries.last3 +
      '</strong> &nbsp;·&nbsp; last 6 months: <strong>' + a.enquiries.last6 + '</strong></div>');
    a.enquiries.unmatched.forEach(function (e) {
      h.push('<div>🔴 No matching disbursed tradeline: ' + esc(e.lender) + ' — ' + inr(e.amount) +
        ' — ' + esc(e.date) + ' (' + esc(e.purpose) + ')</div>');
    });
    if (a.enquiries.hasLiveOverdue && a.enquiries.last3 > 0) {
      h.push('<div>🔴 Fresh enquiries raised while an existing account is overdue.</div>');
    }
    h.push('<div style="margin-top:4px;color:#4b5563">Likely interpretation: ' +
      (a.enquiries.last3 >= 5 ? 'high recent credit-seeking; enquiries without a corresponding disbursed tradeline were <em>likely declined or not taken up</em> — an enquiry can disappear for other reasons, so this is not proof of rejection.'
        : 'enquiry volume is not unusual.') + '</div>');

    // 7. Stacking
    h.push('<div style="font-weight:800;margin:12px 0 5px">7 · Stacking / digital loan pattern</div>');
    if (!a.stacking.length && !a.burst) {
      h.push('<div style="color:#6b7280">No repeat-borrowing pattern detected.</div>');
    } else if (!a.stacking.length && a.burst) {
      h.push('<div>Facilities opened close together: <strong>' + a.burst.count +
        '</strong> across <strong>' + (a.burst.months || 0) + ' month(s)</strong>, spread over different lenders.</div>');
      h.push('<div style="margin-top:4px">Risk signal: 🟠 possible short-term liquidity dependence / loan stacking.</div>');
    } else {
      a.stacking.forEach(function (s) {
        h.push('<div>Repeated lender: <strong>' + esc(s.lender) + '</strong> — loans: ' + s.count +
          ' — opened across ' + s.spanMonths + ' month(s) — average ticket: ' + inr(s.avgTicket) + '</div>');
      });
      h.push('<div style="margin-top:4px">Risk signal: 🟠 possible short-term liquidity dependence / loan stacking.</div>');
    }

    h.push('<div style="margin-top:12px;padding-top:9px;border-top:1px dashed #e5e7eb;font-size:11px;color:#6b7280">' +
      'Figures are read directly from the uploaded CIR; nothing here is estimated. Verify anything you intend to ' +
      'rely on against the report itself.</div>');
    h.push('</div></div>');
    return h.join('');
  }

  // Plain-text version for Applicant_Info.txt.
  function toInfoLines(a) {
    if (!a) return [];
    var L = [];
    L.push('CIBIL deep analysis (from the uploaded report' + (a.consumer.reportDate ? ' dated ' + a.consumer.reportDate : '') + ')');
    L.push('  CreditVision score : ' + (a.scores.score == null ? '—' : a.scores.score));
    if (a.scores.plScore) L.push('  Personal-loan score: ' + a.scores.plScore);
    if (a.scores.factors.length) L.push('  Score factors      : ' + a.scores.factors.join(' | '));
    L.push('  Bureau name        : ' + (a.consumer.name || '—'));
    L.push('  KYC name/dob/sex   : ' + tick(a.kyc.nameMatch).replace(/[^A-Za-z]/g, '') + ' / ' +
      tick(a.kyc.dobMatch).replace(/[^A-Za-z]/g, '') + ' / ' + tick(a.kyc.genderMatch).replace(/[^A-Za-z]/g, ''));
    a.kyc.notes.forEach(function (n) { L.push('  KYC action         : ' + n); });
    L.push('  Overall profile    : ' + a.verdict.toUpperCase());
    L.push('  Accounts           : ' + a.exposure.active + ' active, ' + a.exposure.closed + ' closed');
    L.push('  Total active EMI   : ' + inr(a.exposure.totalActiveEmi));
    L.push('  Outstanding        : ' + inr(a.exposure.totalOutstanding));
    if (a.exposure.interestOnly) L.push('  Gold/interest-only : ' + inr(a.exposure.interestOnly));
    L.push('  Overdue accounts   : ' + a.overdues.length);
    a.overdues.forEach(function (x) {
      L.push('    - ' + (x.lender || 'Not disclosed') + ' | ' + (x.type || '') +
        ' | worst DPD ' + (x.dpd.peakDpd || x.dpd.worstClass || '—') +
        ' | overdue ' + (x.overdue ? inr(x.overdue) : 'Blank') +
        ' | settled ' + (x.settled ? inr(x.settled) : 'Blank') +
        ' | written-off ' + (x.writtenOff ? inr(x.writtenOff) : 'Blank') +
        (x.suitFiled ? ' | SUIT FILED' : ''));
    });
    L.push('  Guarantor accounts : ' + a.guarantor.length);
    a.guarantor.forEach(function (x) {
      L.push('    - ' + (x.lender || 'Not disclosed') + ' | ' + (x.type || '') +
        ' | outstanding ' + inr(x.balance) + ' | worst DPD ' + (x.dpd.peakDpd || x.dpd.worstClass || '—') +
        ' | ' + (x.active ? 'Active' : 'Closed'));
    });
    L.push('  Delinquency pattern: ' + a.pattern);
    L.push('  Enquiries          : ' + (a.enquiries.total == null ? '—' : a.enquiries.total) +
      ' total, ' + a.enquiries.last3 + ' in 3 months, ' + a.enquiries.last6 + ' in 6 months');
    if (a.stacking.length) {
      L.push('  Stacking signal    : ' + a.stacking[0].lender + ' × ' + a.stacking[0].count +
        ' loans over ' + a.stacking[0].spanMonths + ' month(s)');
    }
    if (a.flags.length) L.push('  Flags              : ' + a.flags.join(' | '));
    return L;
  }

  window.CibilAnalysis = {
    extractText: extractText,
    analyse: analyse,
    renderHtml: renderHtml,
    toInfoLines: toInfoLines,
    _internals: { parseAccounts: parseAccounts, parseScores: parseScores,
                  parseEnquiries: parseEnquiries, parseDpdGrid: parseDpdGrid,
                  parseConsumer: parseConsumer, parseEnquirySummary: parseEnquirySummary }
  };
})();
