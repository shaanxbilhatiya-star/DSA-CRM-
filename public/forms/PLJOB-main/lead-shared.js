/* ─────────────────────────────────────────────────────────────────────────────
   Shared helpers for the loan forms (PL/BL/LAP).

   Purpose:
   - Make every submission re-editable. When a form is opened with ?numberId for a
     lead that was already saved, we prefill all the text fields and flip the
     submit button to "Update", and show which documents are already on file.
   - Capture a generic snapshot of every field (by id / radio name) so it can be
     sent to the server on submit and restored later. Documents are optional and
     are handled by each form's own upload logic.
   These functions are intentionally generic so all five forms can share them.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  // The loan-type code is just the file name, e.g. PL_Salaried.html -> PL_Salaried
  var FORM_TYPE = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '');
  window.LEAD_FORM_TYPE = FORM_TYPE;

  // Collect a { fieldId/​radioName : value } map of every input/select/textarea.
  // File inputs are skipped (browsers won't let us restore them for security).
  window.collectFormSnapshot = function collectFormSnapshot() {
    var data = {};
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (el.type === 'file' || el.type === 'button' || el.type === 'submit') return;
      if (el.type === 'radio') {
        if (el.checked && (el.name || el.id)) data[el.name || el.id] = el.value;
        return;
      }
      if (!el.id) return;
      if (el.type === 'checkbox') { data[el.id] = !!el.checked; return; }
      data[el.id] = el.value;
    });
    // Embed prefill status so the server can also verify this was a safe submission
    data['__prefillStatus'] = window.__leadPrefillStatus || 'not_needed';
    return data;
  };

  // Restore a snapshot produced by collectFormSnapshot(). Fires input/change events
  // so any dependent form logic (totals, toggles, previews) recomputes.
  window.applyFormSnapshot = function applyFormSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    Object.keys(data).forEach(function (key) {
      var val = data[key];
      var el = document.getElementById(key);
      if (el && el.type !== 'radio') {
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = val;
        fire(el);
        return;
      }
      // Radios (and anything keyed by name)
      var radios = document.querySelectorAll('input[type="radio"][name="' + cssEscape(key) + '"]');
      if (radios.length) {
        radios.forEach(function (r) {
          r.checked = (r.value === val);
          if (r.checked) fire(r);
        });
      }
    });
  };

  function fire(el) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\]]/g, '\\$&');
  }

  // ── PREFILL STATUS TRACKING ────────────────────────────────────────────────
  // Track whether this form was opened for an existing lead (edit mode) and
  // whether the prefill fetch succeeded. If prefill fails, saving would send
  // empty data that could overwrite the good existing data on the server.
  // window.__leadPrefillStatus:
  //   'not_needed'  → new lead (no numberId), safe to save
  //   'pending'     → prefill fetch in progress
  //   'success'     → prefill loaded correctly, safe to save/update
  //   'failed'      → prefill fetch failed, BLOCK save to prevent data loss
  window.__leadPrefillStatus = 'not_needed';

  // On load: if this form is opened for an existing saved lead, prefill it and
  // switch to "Update" mode.
  window.addEventListener('load', function () {
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    if (!numberId) return;

    window.__leadPrefillStatus = 'pending';

    // Let each form finish its own init first (salary toggles, obligation rows…).
    setTimeout(function () {
      fetch('/api/lead-form/' + encodeURIComponent(numberId))
        .then(function (r) {
          if (!r.ok) throw new Error('Server returned ' + r.status);
          return r.json();
        })
        .then(function (d) {
          if (!d || !d.exists) {
            // Lead doesn't exist on server — treat as new submission (safe to save)
            window.__leadPrefillStatus = 'success';
            return;
          }

          var snapshot = {};
          // Copy all received data into a working snapshot.
          if (d.data && typeof d.data === 'object') {
            Object.keys(d.data).forEach(function (k) { snapshot[k] = d.data[k]; });
          }

          // __salaryType is a special key the server injects when it reconstructs
          // data from older Applicant_Info.txt files. It is NOT a real form field
          // but a trigger for the PL_Salaried salary-type toggle button.
          if (snapshot['__salaryType']) {
            if (typeof window.setSalaryType === 'function') {
              try { window.setSalaryType(snapshot['__salaryType']); } catch (e) {}
            }
            delete snapshot['__salaryType'];
          }

          // Apply the server-reconstructed snapshot first (explicit field IDs,
          // correct date formats, references split, etc.).
          if (Object.keys(snapshot).length > 0) {
            window.applyFormSnapshot(snapshot);
          }

          // Second pass: run the DOM fuzzy label matcher on any infoFields the
          // server returned. This fills in fields the explicit map didn't cover
          // (e.g. form-specific fields added after the mapping was written).
          if (d.infoFields && d.infoFields.length) {
            prefillFromInfoFields(d.infoFields);
          }

          // Prefill succeeded — mark as safe to save/update.
          window.__leadPrefillStatus = 'success';

          markUpdateMode(d);
        })
        .catch(function (err) {
          // Prefill FAILED — mark as unsafe. Show a warning banner.
          window.__leadPrefillStatus = 'failed';
          console.error('Lead prefill failed:', err);

          var wrap = document.querySelector('.wrap') || document.body;
          var warning = document.createElement('div');
          warning.id = 'prefillFailedBanner';
          warning.style.cssText = 'background:linear-gradient(135deg,#fef2f2,#fee2e2);border:2px solid #f87171;border-radius:12px;padding:16px 20px;margin-bottom:16px;color:#991b1b;font-size:14px;line-height:1.6;text-align:center';
          warning.innerHTML =
            '<strong>\u26A0\uFE0F Data Load Failed</strong><br>' +
            'Could not load the existing lead data. Saving now would overwrite the customer\'s information with empty fields.<br>' +
            '<strong>Please reload the page or check your connection before making changes.</strong><br>' +
            '<button type="button" onclick="location.reload()" style="margin-top:10px;padding:8px 20px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">\uD83D\uDD04 Reload Page</button>';
          wrap.insertBefore(warning, wrap.children[1] || wrap.firstChild);

          // Disable the submit button to prevent accidental data loss
          var btn = document.getElementById('submitBtn');
          if (btn) {
            btn.disabled = true;
            btn.title = 'Cannot save — existing data failed to load. Reload the page first.';
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
          }
        });
    }, 400);
  });

  // Normalise a label for fuzzy comparison: lowercase, drop bracketed notes and
  // punctuation, collapse whitespace. e.g. "Mobile number *" -> "mobile number".
  function normLabel(s) {
    return String(s || '')
      .replace(/\(.*?\)/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function setFieldValue(el, value) {
    try {
      if (el.tagName === 'SELECT') {
        var want = normLabel(value);
        var opt = Array.prototype.find.call(el.options, function (o) {
          return normLabel(o.textContent) === want || normLabel(o.value) === want;
        });
        el.value = opt ? opt.value : value;
      } else if (el.type === 'checkbox') {
        el.checked = /^(yes|true|1|on|checked)$/i.test(String(value).trim());
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }

  // Prefill this form's fields from a legacy lead's parsed "label : value" list by
  // matching each saved label to the closest field label on the form.
  function prefillFromInfoFields(fields) {
    var entries = [];
    document.querySelectorAll('.fi').forEach(function (fi) {
      var labelEl = fi.querySelector('label');
      var input = fi.querySelector('input, select, textarea');
      if (!labelEl || !input || input.type === 'file') return;
      entries.push({ n: normLabel(labelEl.textContent), el: input });
    });
    var used = [];
    function take(el) { used.push(el); }
    function free(el) { return used.indexOf(el) === -1; }

    // Pass 1 — exact normalised label match.
    fields.forEach(function (f) {
      if (f.heading || !f.value) return;
      var fn = normLabel(f.label);
      if (!fn) return;
      var hit = entries.find(function (e) { return free(e.el) && e.n === fn; });
      if (hit) { setFieldValue(hit.el, f.value); take(hit.el); }
    });
    // Pass 2 — one label is contained in the other (e.g. "Mobile" vs "Mobile number").
    fields.forEach(function (f) {
      if (f.heading || !f.value) return;
      var fn = normLabel(f.label);
      if (fn.length < 3) return;
      var hit = entries.find(function (e) {
        return free(e.el) && e.n.length >= 3 && (e.n.indexOf(fn) !== -1 || fn.indexOf(e.n) !== -1);
      });
      if (hit) { setFieldValue(hit.el, f.value); take(hit.el); }
    });
  }

  function markUpdateMode(d) {
    var btn = document.getElementById('submitBtn');
    if (btn) {
      btn.innerHTML = btn.innerHTML
        .replace(/Save\s*&amp;\s*Download\s*File/i, 'Update File')
        .replace(/Save\s*&\s*Download\s*File/i, 'Update File')
        .replace(/Save\s*File/i, 'Update File');
    }
    var docs = (d && d.docs) || [];
    var shareToken = d && d.shareToken;
    var wrap = document.querySelector('.wrap') || document.body;

    // ── SMART FORM SWITCH BUTTON ──────────────────────────────────────────────
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    var agentId = p.get('agentId');
    if (numberId && agentId) {
      insertFormSwitcher(wrap, numberId, agentId, d);
    }

    // ── EDIT BANNER ───────────────────────────────────────────────────────────
    var banner = document.createElement('div');
    banner.id = 'editModeBanner';
    banner.style.cssText = 'background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #6ee7b7;border-radius:12px;padding:14px 18px;margin-bottom:16px;color:#065f46;font-size:13.5px;line-height:1.6';
    var docList = docs.length
      ? '<div style="margin-top:6px;font-size:12.5px;color:#047857">\uD83D\uDCCE ' + docs.length + ' document(s) on file</div>'
      : '';
    banner.innerHTML =
      '<strong>&#128260; Editing an existing submission.</strong> ' +
      'Your saved details have been loaded below. Change anything you like and press ' +
      '<strong>Update File</strong> to save. Re-uploading documents is optional \u2014 ' +
      'leave a document empty to keep the one already on file.' + docList;
    wrap.insertBefore(banner, wrap.children[1] || wrap.firstChild);

    // ── Show existing documents on each upload field ──────────────────────────
    if (docs.length && shareToken) {
      markExistingDocs(docs, shareToken);
    }
  }

  // ── FORM SWITCHER ─────────────────────────────────────────────────────────────
  var FORM_OPTIONS = [
    { value: 'BL_Business',  label: 'BL \u2014 Business Loan' },
    { value: 'LAP_Business', label: 'LAP \u2014 Loan Against Property (Business)' },
    { value: 'LAP_Salaried', label: 'LAP \u2014 Loan Against Property (Salaried)' },
    { value: 'PL_Business',  label: 'PL \u2014 Personal Loan (Business)' },
    { value: 'PL_Salaried',  label: 'PL \u2014 Personal Loan (Salaried / Job)' }
  ];

  function insertFormSwitcher(wrap, numberId, agentId, leadData) {
    var currentForm = FORM_TYPE;
    var switcher = document.createElement('div');
    switcher.id = 'formSwitcher';
    switcher.style.cssText = 'background:#fff;border:1.5px solid #e0e7ff;border-radius:14px;padding:14px 18px;margin-bottom:14px;box-shadow:0 2px 12px rgba(99,102,241,.08)';
    var currentLabel = '';
    FORM_OPTIONS.forEach(function (o) { if (o.value === currentForm) currentLabel = o.label; });
    var html = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">';
    html += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">\uD83D\uDD04</span>';
    html += '<div><div style="font-size:11px;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.4px">Current Form</div>';
    html += '<div style="font-size:14px;font-weight:600;color:#1e1b4b">' + escapeHtml(currentLabel || currentForm) + '</div></div></div>';
    html += '<button type="button" id="switchFormBtn" style="padding:8px 16px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 2px 8px rgba(99,102,241,.3)">\uD83D\uDD00 Switch Form Type</button></div>';
    html += '<div id="switchPanel" style="display:none;margin-top:14px;padding-top:14px;border-top:1px dashed #c7d2fe">';
    html += '<div style="font-size:12px;font-weight:600;color:#4338ca;margin-bottom:8px">\uD83D\uDCA1 Switch to a different loan type \u2014 your data & documents carry over automatically</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px" id="switchOptions">';
    FORM_OPTIONS.forEach(function (o) {
      if (o.value === currentForm) return;
      html += '<button type="button" class="switch-opt-btn" data-form="' + o.value + '" style="padding:9px 14px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:9px;font-size:12.5px;font-weight:600;color:#334155;cursor:pointer;font-family:inherit">' + escapeHtml(o.label) + '</button>';
    });
    html += '</div>';
    html += '<div id="switchConfirm" style="display:none;margin-top:12px;padding:12px;background:#fef3c7;border:1px solid #fbbf24;border-radius:9px">';
    html += '<div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:8px" id="switchConfirmMsg"></div>';
    html += '<div style="display:flex;gap:8px"><button type="button" id="switchGoBtn" style="padding:8px 18px;background:#16a34a;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">\u2705 Yes, switch now</button>';
    html += '<button type="button" id="switchCancelBtn" style="padding:8px 14px;background:#fff;color:#64748b;border:1px solid #d1d5db;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Cancel</button></div></div></div>';
    switcher.innerHTML = html;
    wrap.insertBefore(switcher, wrap.firstChild);

    var selectedTarget = null;
    document.getElementById('switchFormBtn').addEventListener('click', function () {
      var panel = document.getElementById('switchPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.querySelectorAll('.switch-opt-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedTarget = btn.getAttribute('data-form');
        var targetLabel = '';
        FORM_OPTIONS.forEach(function (o) { if (o.value === selectedTarget) targetLabel = o.label; });
        document.getElementById('switchConfirmMsg').textContent = 'Switch from "' + (currentLabel || currentForm) + '" to "' + targetLabel + '"? All matching fields & documents will carry over.';
        document.getElementById('switchConfirm').style.display = 'block';
        document.querySelectorAll('.switch-opt-btn').forEach(function (b) {
          b.style.borderColor = b === btn ? '#16a34a' : '#e2e8f0';
          b.style.background = b === btn ? '#f0fdf4' : '#f8fafc';
          b.style.color = b === btn ? '#16a34a' : '#334155';
        });
      });
    });
    document.getElementById('switchCancelBtn').addEventListener('click', function () {
      document.getElementById('switchConfirm').style.display = 'none';
      selectedTarget = null;
      document.querySelectorAll('.switch-opt-btn').forEach(function (b) { b.style.borderColor = '#e2e8f0'; b.style.background = '#f8fafc'; b.style.color = '#334155'; });
    });
    document.getElementById('switchGoBtn').addEventListener('click', function () {
      if (!selectedTarget) return;
      performFormSwitch(selectedTarget, numberId, agentId);
    });
  }

  function performFormSwitch(targetForm, numberId, agentId) {
    var snapshot = window.collectFormSnapshot ? window.collectFormSnapshot() : {};
    try {
      sessionStorage.setItem('__formSwitch_snapshot', JSON.stringify(snapshot));
      sessionStorage.setItem('__formSwitch_from', FORM_TYPE);
    } catch (e) {}
    fetch('/api/agent/switch-form-type/' + encodeURIComponent(numberId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numberId: numberId, agentId: agentId, loanType: targetForm })
    }).catch(function () {});
    location.href = '/forms/PLJOB-main/' + targetForm + '.html?numberId=' + encodeURIComponent(numberId) + '&agentId=' + encodeURIComponent(agentId);
  }

  // On load: check if we arrived via a form switch and apply carried-over data
  window.addEventListener('load', function () {
    try {
      var switchSnapshot = sessionStorage.getItem('__formSwitch_snapshot');
      var switchFrom = sessionStorage.getItem('__formSwitch_from');
      if (switchSnapshot) {
        sessionStorage.removeItem('__formSwitch_snapshot');
        sessionStorage.removeItem('__formSwitch_from');
        var data = JSON.parse(switchSnapshot);
        setTimeout(function () {
          if (data && typeof data === 'object') {
            Object.keys(data).forEach(function (key) {
              var val = data[key];
              if (!val || (typeof val === 'string' && !val.trim())) return;
              var el = document.getElementById(key);
              if (!el || el.type === 'file') return;
              if (el.value && el.value.trim()) return;
              if (el.type === 'checkbox') el.checked = !!val;
              else el.value = val;
              fire(el);
            });
          }
          var toast = document.createElement('div');
          toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;font-size:14px;font-weight:600;border-radius:12px;padding:12px 24px;z-index:9999;box-shadow:0 8px 30px rgba(99,102,241,.35)';
          toast.textContent = '\u2705 Switched from ' + (switchFrom || 'previous form') + ' \u2014 data carried over!';
          document.body.appendChild(toast);
          setTimeout(function () { toast.remove(); }, 3500);
        }, 600);
      }
    } catch (e) {}
  });

  // ── DOC LABEL → UPLOAD INPUT ID MAPPING ─────────────────────────────────────
  // Maps document filenames/labels (as stored in the ZIP) to the upload input IDs
  // used across all 5 loan form types.
  var DOC_TO_INPUT = {
    // ── Common KYC (all forms) ──
    'aadhaar card':           'up_aadhaar',
    'aadhaar':                'up_aadhaar',
    'pan card':               'up_pan',
    'pan':                    'up_pan',
    'passport photo':         'up_photo',
    'passport size photo':    'up_photo',
    'photo':                  'up_photo',
    // ── Address / Utility ──
    'electricity bill':       'up_elec',
    'elec bill':              'up_elec',
    // ── CIBIL ──
    'cibil report':           'up_cibil',
    'cibil':                  'up_cibil',
    // ── Income docs (PL_Salaried, LAP_Salaried) ──
    'salary slip':            'up_salary',
    'salary slips':           'up_salary',
    'pay slip':               'up_salary',
    'form 16':                'up_form16',
    'form16':                 'up_form16',
    // ── Bank / Financial ──
    'bank statement':         'up_bank',
    'bank stmt':              'up_bank',
    'cancelled cheque':       'up_cheque',
    'cheque':                 'up_cheque',
    'soa statement':          'up_soa',
    'soa':                    'up_soa',
    'soa statement always':   'up_soa_always',
    // ── Business docs (BL_Business, PL_Business, LAP_Business) ──
    'gst certificate':        'up_gst',
    'gst':                    'up_gst',
    'udhyam certificate':     'up_udhyam',
    'udhyam':                 'up_udhyam',
    'udyam certificate':      'up_udhyam',
    'udyam':                  'up_udhyam',
    'gumastha shop act':      'up_gumastha',
    'gumastha':               'up_gumastha',
    'shop act':               'up_gumastha',
    'itr 3years':             'up_itr',
    'itr':                    'up_itr',
    'itr 3 years':            'up_itr',
    'business address proof': 'up_biz_addr_proof',
    'biz addr proof':         'up_biz_addr_proof',
    'shop video':             'up_shop_video',
    'business vintage proof': 'up_vintage',
    'vintage proof':          'up_vintage',
    'trade license':          'up_trade',
    'trade':                  'up_trade',
    // ── PL_Salaried specific ──
    'appointment letter id':  'up_appt',
    'appointment letter':     'up_appt',
    'employee id':            'up_appt',
    // ── BL_Business specific ──
    'permanent address proof':'up_perm_proof',
    'perm addr proof':        'up_perm_proof',
    // ── LAP Property docs (LAP_Business + LAP_Salaried) ──
    'property video':         'up_prop_video',
    'registry':               'up_registry',
    'patta':                  'up_patta',
    'khasra agri':            'up_khasra_agri',
    'khasra':                 'up_khasra',
    'rin pustika':            'up_rin',
    'rin':                    'up_rin',
    'khatauni':               'up_khatauni',
    'b1 agri':                'up_b1_agri',
    'b1':                     'up_b1',
    'registry shop':          'up_registry_shop',
    'diversion shop':         'up_div_shop',
    'khasra shop':            'up_khasra_shop',
    'shop naksha':            'up_shop_naksha',
    'patta village':          'up_patta_v',
    'khasra village':         'up_khasra_v',
    'noc':                    'up_noc',
    'village misc':           'up_village_misc',
    'naksha':                 'up_naksha',
    'diversion':              'up_diversion',
    'khasra b1':              'up_khasra_b1',
    'tax receipt':            'up_tax_etc',
    'tax':                    'up_tax_etc',
    'registry plot':          'up_registry_plot',
    'diversion plot':         'up_div_plot',
    'plot misc':              'up_plot_misc',
    'agri misc':              'up_agri_misc',
    'shop misc':              'up_shop_misc',
    // ── LAP Owner docs ──
    'owner1 aadhaar':         'up_owner1_aadhaar',
    'owner 1 aadhaar':        'up_owner1_aadhaar',
    'owner1 pan':             'up_owner1_pan',
    'owner 1 pan':            'up_owner1_pan',
    'owner2 aadhaar':         'up_owner2_aadhaar',
    'owner 2 aadhaar':        'up_owner2_aadhaar',
    'owner2 pan':             'up_owner2_pan',
    'owner 2 pan':            'up_owner2_pan',
    'owner other aadhaar':    'up_owner_other_aadhaar',
    'owner other pan':        'up_owner_other_pan',
    // LAP additional
    'khasra plot':            'up_khasra_plot',
    'b1 plot':                'up_b1_plot',
    'namantaran':             'up_namantaran',
    'ptax':                   'up_ptax',
    'property tax':           'up_ptax',
  };

  function normDocLabel(s) {
    return String(s || '').toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/\.[a-z]{2,5}$/, '')   // strip file extension
      .replace(/\s*\d+$/, '')          // strip trailing number (e.g. "Bank Statement 1")
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findUploadInput(docLabel, docFilename) {
    var candidates = [normDocLabel(docLabel), normDocLabel(docFilename)];
    for (var c = 0; c < candidates.length; c++) {
      var norm = candidates[c];
      if (!norm) continue;
      if (DOC_TO_INPUT[norm]) return DOC_TO_INPUT[norm];
      var keys = Object.keys(DOC_TO_INPUT);
      for (var i = 0; i < keys.length; i++) {
        if (norm.indexOf(keys[i]) !== -1 || keys[i].indexOf(norm) !== -1) {
          return DOC_TO_INPUT[keys[i]];
        }
      }
    }
    return null;
  }

  function markExistingDocs(docs, shareToken) {
    // Group docs by upload input (multiple files can map to same input)
    var grouped = {};
    docs.forEach(function (doc) {
      var inputId = findUploadInput(doc.label, doc.filename);
      if (!inputId) return;
      if (!grouped[inputId]) grouped[inputId] = [];
      grouped[inputId].push(doc);
    });

    Object.keys(grouped).forEach(function (inputId) {
      var inputEl = document.getElementById(inputId);
      if (!inputEl) return;

      var ubEl = inputEl.closest('.ub');
      if (!ubEl) return;

      var docList = grouped[inputId];

      // Mark the upload button as "already uploaded"
      ubEl.classList.add('uploaded');

      // Create a visual indicator showing the existing docs with view links
      var indicator = document.createElement('div');
      indicator.className = 'existing-doc-indicator';
      indicator.style.cssText = 'margin-top:8px;padding:9px 12px;background:linear-gradient(135deg,#ecfdf5,#f0fdf4);border:1.5px solid #86efac;border-radius:9px;font-size:12.5px;color:#166534;line-height:1.5';

      var html = '<div style="font-weight:700;margin-bottom:5px;display:flex;align-items:center;gap:5px">' +
        '<span style="font-size:14px">\u2705</span> Already on file' +
        (docList.length > 1 ? ' (' + docList.length + ' files)' : '') +
        '</div>';

      html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
      docList.forEach(function (doc) {
        var viewUrl = '/share/' + encodeURIComponent(shareToken) + '/doc/' + encodeURIComponent(doc.id);
        html += '<span style="display:inline-flex;align-items:center;gap:2px;background:#fff;border:1px solid #bbf7d0;border-radius:6px;padding:0;overflow:hidden">' +
          '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener" ' +
          'style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;color:#15803d;text-decoration:none;font-size:11.5px;font-weight:600;transition:all .15s"' +
          ' onmouseover="this.style.background=\'#dcfce7\'"' +
          ' onmouseout="this.style.background=\'transparent\'">' +
          '\uD83D\uDCC4 ' + escapeHtml(doc.label || doc.filename) +
          '</a>' +
          '<button type="button" onclick="window.__removeDoc(\'' + escapeHtml(doc.id) + '\',this)" ' +
          'style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:transparent;border:none;border-left:1px solid #bbf7d0;color:#dc2626;font-size:13px;cursor:pointer;transition:all .15s;padding:0" ' +
          'onmouseover="this.style.background=\'#fef2f2\'" onmouseout="this.style.background=\'transparent\'" ' +
          'title="Remove this document">\u2715</button>' +
          '</span>';
      });
      html += '</div>';
      html += '<div style="margin-top:5px;font-size:11px;color:#16a34a;font-style:italic">Re-upload to replace \u00b7 Click \u2715 to remove a document</div>';

      indicator.innerHTML = html;
      ubEl.parentNode.insertBefore(indicator, ubEl.nextSibling);

      // Update the filename display if present
      var fnEl = ubEl.parentNode.querySelector('.fn');
      if (fnEl) {
        fnEl.textContent = '\u2705 ' + docList.map(function (d) { return d.filename; }).join(', ') + ' (on file)';
        fnEl.style.display = 'block';
        fnEl.style.color = '#16a34a';
      }

      // Update document checklist if present
      if (typeof window.updateChecklist === 'function') {
        try { window.updateChecklist(inputId, true); } catch (e) {}
      }
    });

    // Show unmatched docs in the banner
    var unmatchedDocs = docs.filter(function (doc) {
      return !findUploadInput(doc.label, doc.filename);
    });
    if (unmatchedDocs.length > 0) {
      var bannerEl = document.getElementById('editModeBanner');
      if (bannerEl) {
        var extra = '<div style="margin-top:8px;padding:8px 12px;background:rgba(255,255,255,.6);border-radius:8px;font-size:12px">' +
          '<strong>Other documents on file:</strong> ';
        extra += unmatchedDocs.map(function (doc) {
          var viewUrl = '/share/' + encodeURIComponent(shareToken) + '/doc/' + encodeURIComponent(doc.id);
          return '<a href="' + escapeHtml(viewUrl) + '" target="_blank" style="color:#047857;text-decoration:underline">' +
            escapeHtml(doc.label || doc.filename) + '</a>';
        }).join(', ');
        extra += '</div>';
        bannerEl.innerHTML += extra;
      }
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Remove individual document from server ──────────────────────────────────
  // Called by the ✕ button next to each "Already on file" document.
  window.__removeDoc = function (docId, btnEl) {
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    var agentId = p.get('agentId');
    if (!numberId) { alert('Cannot remove: no lead ID'); return; }
    if (!confirm('Remove this document permanently? This cannot be undone.')) return;

    // Disable button during request
    btnEl.disabled = true;
    btnEl.style.opacity = '0.4';

    fetch('/api/agent/doc/' + encodeURIComponent(numberId) + '/' + encodeURIComponent(docId), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId || '' })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          alert('Failed to remove: ' + d.error);
          btnEl.disabled = false;
          btnEl.style.opacity = '1';
          return;
        }
        // Remove the doc chip from the UI
        var chip = btnEl.closest('span');
        if (chip) {
          var indicator = chip.closest('.existing-doc-indicator');
          chip.remove();
          // Update count in the indicator header
          if (indicator) {
            var remaining = indicator.querySelectorAll('span > a').length;
            if (remaining === 0) {
              // No docs left — remove the entire indicator and un-mark the upload button
              var ubEl = indicator.previousElementSibling;
              if (ubEl && ubEl.classList.contains('ub')) {
                ubEl.classList.remove('uploaded');
              }
              // Clear the filename display
              var fnEl = indicator.parentNode.querySelector('.fn');
              if (fnEl) { fnEl.style.display = 'none'; fnEl.textContent = ''; }
              indicator.remove();
            } else {
              // Update the header count
              var header = indicator.querySelector('div');
              if (header) {
                header.innerHTML = '<span style="font-size:14px">\u2705</span> Already on file' +
                  (remaining > 1 ? ' (' + remaining + ' files)' : '');
              }
            }
          }
        }
        // Show a brief toast
        var toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#dc2626;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.25)';
        toast.textContent = '\uD83D\uDDD1\uFE0F Document removed';
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 2500);
      })
      .catch(function (e) {
        alert('Network error: ' + e.message);
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
      });
  };
})();
