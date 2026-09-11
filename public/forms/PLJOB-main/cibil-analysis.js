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
            var rows = {};
            tc.items.forEach(function (it) {
              var y = Math.round((it.transform ? it.transform[5] : 0) * -1);
              (rows[y] = rows[y] || []).push(it.str);
            });
            var lines = Object.keys(rows).sort(function (a, b) { return a - b; })
              .map(function (k) { return rows[k].join(' ').replace(/\s+/g, ' ').trim(); });
            return acc + lines.join('\n') + '\n';
          });
        });
      }, Promise.resolve(''));
    });
  }

  /* ── parsing ─────────────────────────────────────────────────────────────── */

  function parseConsumer(text) {
    return {
      name: firstMatch(text, /CONSUMER\s*NAME\s*:\s*([^\n]+)/i),
      dob: firstMatch(text, /\bD\.?O\.?B\.?\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
      gender: firstMatch(text, /\bGENDER\s*:\s*([A-Za-z]+)/i),
      pan: firstMatch(text, /\bPAN(?:\s*CARD)?\s*:\s*([A-Z]{5}\d{4}[A-Z])/i),
      reportDate: firstMatch(text, /REPORT DATE\s*&?\s*TIME\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
      control: firstMatch(text, /CONTROL NUMBER\s*:\s*(\d+)/i)
    };
  }

  function parseScores(text) {
    var score = firstMatch(text, /CREDITVISION\s*(?:®|\(R\))?\s*SCORE\s*:\s*(\d{3})/i);
    if (!score) {
      // Fallback: the gauge prints the number on its own after the 300..900 scale.
      score = firstMatch(text, /300\s*\(high risk\)\s*to\s*900\s*\(low risk\)[^\d]*300\s*900\s*(\d{3})/i);
    }
    var factors = [];
    var re = /SCORING FACTORS([\s\S]{0,400}?)(?=\n\s*(?:PERSONAL LOAN|ACCOUNTS|CONSUMER|TOTAL ENQUIRIES|CREDITVISION|$))/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      m[1].split('\n').forEach(function (l) {
        var f = /^\s*\d+\.\s*(.+?)\s*$/.exec(l);
        if (f && factors.indexOf(f[1]) === -1) factors.push(f[1]);
      });
    }
    return {
      score: score ? parseInt(score, 10) : null,
      plScore: (function () {
        var m2 = /PERSONAL LOAN\s*Score[\s\S]{0,200}?300\s*900\s*(\d{3})/i.exec(text);
        return m2 ? parseInt(m2[1], 10) : null;
      })(),
      factors: factors
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
    var chunks = body.split(/ACCOUNT INFORMATION/i).slice(1);
    return chunks.map(function (raw, idx) {
      var block = raw.split(/GLOSSARY/i)[0];
      var flat = block.replace(/\s+/g, ' ');
      var grid = parseDpdGrid(block);
      var writtenOff = num(firstMatch(block, /WRITTEN OFF\s*\(TOTAL\)\s*:\s*₹?\s*([\d,]+)/i));
      var writtenOffPr = num(firstMatch(block, /WRITTEN OFF\s*\(PRINCIP(?:LE|AL)\)\s*:\s*₹?\s*([\d,]+)/i));
      var settled = num(firstMatch(block, /SETTL(?:ED|EMENT)\s*(?:AMOUNT)?\s*:\s*₹?\s*([\d,]+)/i));
      return {
        index: idx + 1,
        active: /\bACTIVE\b/i.test(flat.slice(0, 200)) && !/\bINACTIVE\b/i.test(flat.slice(0, 200)),
        type: firstMatch(flat, /TYPE\s*:\s*(.+?)\s+MEMBER/i) || firstMatch(flat, /TYPE\s*:\s*([A-Z][A-Z\s()\u2013–-]{2,50})/i),
        lender: firstMatch(flat, /MEMBER\s*NAME\s*:\s*(.+?)\s+ACCOUNT/i),
        ownership: (firstMatch(flat, /OWNERSHIP\s*:\s*([A-Z]+)/i) || '').toUpperCase(),
        opened: firstMatch(flat, /DATE OPENED\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
        closed: firstMatch(flat, /DATE CLOSED\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
        reported: firstMatch(flat, /DATE REPORTED[^:]*:\s*(\d{2}\/\d{2}\/\d{4})/i),
        sanctioned: num(firstMatch(flat, /SANCTIONED\s*AMOUNT\s*:\s*₹?\s*([\d,]+)/i)) ||
                    num(firstMatch(flat, /HIGH CREDIT\s*AMOUNT\s*:\s*₹?\s*([\d,]+)/i)),
        balance: num(firstMatch(flat, /CURRENT\s*BALANCE\s*:\s*₹?\s*([\d,]+)/i)),
        overdue: num(firstMatch(flat, /\bOVERDUE\s*:\s*₹?\s*([\d,]+)/i)),
        emi: num(firstMatch(flat, /\bEMI\s*:\s*₹?\s*([\d,]+)/i)),
        collateralType: firstMatch(flat, /COLLATERAL\s*TYPE\s*:\s*([A-Z ]+?)(?:\s+STATUS|\s+PAYMENT|$)/i),
        // Bounded, and stopped by whatever field follows — the value itself can wrap
        // across lines ("RESTRUCTURED DUE TO" / "COVID-19"), so it cannot simply be
        // read to end of line, but left unbounded it swallows the DPD grid.
        facilityStatus: firstMatch(flat, /CREDIT\s*FACILITY\s*STATUS\s*:\s*([A-Z0-9 \-–]{3,40}?)\s*(?=\s(?:WRITTEN|SUIT|DAYS|YEAR|ACCOUNT|\d{4}\s)|$)/i),
        suitFiled: /SUIT FILED/i.test(flat),
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

    var totalActiveEmi = active.reduce(function (s, a) { return s + (a.emi || 0); }, 0);
    var totalOutstanding = active.reduce(function (s, a) { return s + (a.balance || 0); }, 0);
    var totalSanctioned = accounts.reduce(function (s, a) { return s + (a.sanctioned || 0); }, 0);

    // Gold / on-demand facilities carry no amortising EMI, so they are called out
    // separately rather than being folded into the EMI total.
    var interestOnly = active.filter(function (a) {
      return /GOLD|KISAN CREDIT CARD|OVERDRAFT/i.test(a.type || '') || (!a.emi && a.balance > 0);
    });

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

    var lendersWithStress = {};
    history.forEach(function (h) { if (h.peakDpd >= 30) lendersWithStress[h.lender] = 1; });
    var stressLenders = Object.keys(lendersWithStress).length;
    var pattern = history.length === 0 ? 'Clean repayment record'
      : history.filter(function (h) { return h.peakDpd >= 30; }).length <= 1 ? 'One-off'
      : stressLenders > 1 ? 'Multi-lender stress' : 'Repeated with a single lender';

    // Enquiries with no tradeline opened near the same date. Deliberately not
    // called a rejection: an enquiry can vanish for other reasons.
    var unmatched = enquiries.filter(function (e) {
      var ed = dmyToDate(e.date);
      if (!ed) return false;
      return !accounts.some(function (a) {
        var od = dmyToDate(a.opened);
        if (!od) return false;
        var gap = Math.abs(monthsBetween(ed, od) || 99);
        return gap <= 2;
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
      var k = (a.lender || 'Not disclosed').toUpperCase();
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

    var flags = [];
    if (scores.score != null && scores.score < 650) flags.push('Score below 650');
    if (overdues.length) flags.push(overdues.length + ' account(s) with overdue / default markers');
    if (guarantor.length) flags.push(guarantor.length + ' guarantor-linked account(s)');
    if (enq3 >= 5) flags.push(enq3 + ' enquiries in the last 3 months');
    if (stacking.length) flags.push('Repeat borrowing pattern with ' + stacking[0].lender);
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
      guarantor: guarantor, history: history.slice(0, 8), pattern: pattern,
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
    h.push('<div>Score: <strong style="font-size:15px">' + (a.scores.score == null ? '—' : a.scores.score) +
      '</strong>' + (a.scores.plScore ? ' &nbsp;·&nbsp; Personal-loan score: <strong>' + a.scores.plScore + '</strong>' : '') + '</div>');
    if (a.scores.factors.length) {
      h.push('<div style="margin-top:3px">Score factors (bureau wording):<ul style="margin:3px 0 0 18px;padding:0">' +
        a.scores.factors.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>');
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
    if (!a.stacking.length) {
      h.push('<div style="color:#6b7280">No repeat-borrowing pattern detected.</div>');
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
    L.push('  Score              : ' + (a.scores.score == null ? '—' : a.scores.score) +
      (a.scores.plScore ? '  (personal-loan score ' + a.scores.plScore + ')' : ''));
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
