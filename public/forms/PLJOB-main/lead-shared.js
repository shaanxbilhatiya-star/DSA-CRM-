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
      if (el.type === 'password') return;  // SECURITY: never persist passwords
      if (el.type === 'radio') {
        if (el.checked && (el.name || el.id)) data[el.name || el.id] = el.value;
        return;
      }
      if (!el.id) return;
      if (el.type === 'checkbox') { data[el.id] = !!el.checked; return; }
      data[el.id] = el.value;
    });
    
    // Capture obligation rows (they use classes, not IDs, so the above loop missed them)
    var obligations = [];
    document.querySelectorAll('.ob-row').forEach(function (row) {
      var type = row.querySelector('.ob-type');
      var bank = row.querySelector('.ob-bank');
      var emi = row.querySelector('.ob-emi');
      if (type && bank && emi) {
        obligations.push({
          type: type.value || '',
          bank: bank.value || '',
          emi: emi.value || ''
        });
      }
    });
    if (obligations.length > 0) {
      data['__obligations'] = obligations;
    }
    
    // Capture Other Documents metadata (names of custom documents uploaded)
    // otherDocsData is a global array defined in each form that has Other Documents feature
    if (typeof window.otherDocsData !== 'undefined' && window.otherDocsData && window.otherDocsData.length > 0) {
      var otherDocs = [];
      window.otherDocsData.forEach(function(doc) {
        if (doc.file || doc.name) {  // Either has file or at least has a name
          otherDocs.push({
            name: doc.name || 'Unnamed Document',
            filename: doc.file ? doc.file.name : null,
            size: doc.file ? doc.file.size : null,
            // Which section the agent filed this document under. The stored
            // filename carries it too; this keeps it readable in the snapshot.
            section: (typeof window.__otherDocSection === 'function')
              ? window.__otherDocSection(doc.id) : ''
          });
        }
      });
      if (otherDocs.length > 0) {
        data['__otherDocs'] = otherDocs;
      }
    }

    // The CIBIL summary travels with the lead so it is there on reopening and can be
    // shown under CIBIL on the view page without re-reading the report.
    if (window.__cibilAnalysis) data['__cibilAnalysis'] = window.__cibilAnalysis;

    // Salary type and property type are picked with buttons, not form controls, so
    // the loop above never saw them and both came back unselected on reopening even
    // though they were already decided. The forms mirror the choice onto window.
    if (typeof window.salaryType === 'string' && window.salaryType) data['__salaryType'] = window.salaryType;
    if (typeof window.selectedProp === 'string' && window.selectedProp) data['__propType'] = window.selectedProp;

    // Capture co-applicants / guarantors. Their individual field inputs are also
    // picked up by the id loop above, but this records the roles and slot numbers
    // that the rows have to be rebuilt from before those values mean anything.
    if (typeof window.__collectParties === 'function') {
      var parties = window.__collectParties();
      if (parties.length > 0) data['__parties'] = parties;
    }

    // Embed prefill status so the server can also verify this was a safe submission
    data['__prefillStatus'] = window.__leadPrefillStatus || 'not_needed';
    return data;
  };

  // Restore a snapshot produced by collectFormSnapshot(). Fires input/change events
  // so any dependent form logic (totals, toggles, previews) recomputes.
  window.applyFormSnapshot = function applyFormSnapshot(data) {
    if (!data || typeof data !== 'object') return;

    // ── PHASE 0: Rebuild co-applicant / guarantor rows, synchronously ──
    // Must happen before anything defers: markExistingDocs() runs as soon as this
    // function returns, so a party's upload fields have to exist by then for their
    // stored documents to attach to the right person.
    if (data['__parties'] && typeof window.__restoreParties === 'function') {
      try { window.__restoreParties(data['__parties']); }
      catch (e) { console.warn('Could not restore co-applicant/guarantor rows', e); }
    }

    // Show the stored CIBIL summary again when a lead is reopened, so it is visible
    // in edit mode without the agent having to re-attach the report.
    if (data['__cibilAnalysis']) {
      window.__cibilAnalysis = data['__cibilAnalysis'];
      setTimeout(function () {
        var box = cibilBox();
        if (box && typeof window.CibilAnalysis !== 'undefined') {
          try { box.innerHTML = window.CibilAnalysis.renderHtml(data['__cibilAnalysis']); }
          catch (e) { /* leave the field as-is if the stored shape is unexpected */ }
        }
      }, 60);
    }

    // Re-apply the button-driven choices. Both also reveal their dependent sections
    // (property paperwork, Form 16), so they run before any field values are set.
    if (data['__salaryType'] && typeof window.setSalaryType === 'function') {
      try { window.setSalaryType(data['__salaryType']); } catch (e) {}
    }
    if (data['__propType'] && typeof window.selectProp === 'function') {
      try { window.selectProp(data['__propType']); } catch (e) {}
    }
    
    // ── PHASE 1: Identify and trigger conditional visibility controls FIRST ──
    // These fields control which sections are visible. Set them before other fields
    // so that hidden fields become visible and can receive their values.
    // NOTE: property type is NOT listed here. It is chosen with buttons and has no
    // f_prop_type element, so the entry that used to sit here could never fire; it
    // is restored from __propType in phase 0 below instead.
    var visibilityTriggers = {
      'f_owner_type': 'toggleOwnerKyc',        // LAP forms: Father/Mother owner KYC
      'f_perm_same': 'togglePermanent'         // BL_Business: Permanent address
    };
    
    Object.keys(visibilityTriggers).forEach(function(fieldId) {
      if (data[fieldId]) {
        var el = document.getElementById(fieldId);
        var funcName = visibilityTriggers[fieldId];
        if (el && typeof window[funcName] === 'function') {
          try {
            if (el.type === 'checkbox') el.checked = !!data[fieldId];
            else if (el.type === 'select-one' || el.type === 'text') el.value = data[fieldId];
            fire(el);
            // Explicitly call the visibility toggle function
            window[funcName](data[fieldId]);
          } catch (e) { console.warn('Failed to trigger visibility for ' + fieldId, e); }
        }
      }
    });
    
    // Small delay to ensure DOM updates from visibility toggles are complete
    setTimeout(function() {
      
      // ── PHASE 2: Apply all other field values ──
      Object.keys(data).forEach(function (key) {
        // Skip internal tracking keys
        if (key.indexOf('__') === 0) return;
        // Skip fields we already handled in phase 1
        if (visibilityTriggers[key]) return;
        
        var val = data[key];
        var el = document.getElementById(key);
        if (el) {
          if (el.type === 'file') return;  // SAFETY: never try to set file input values
          if (el.type === 'radio') return; // radios handled below
          try {
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = val;
            fire(el);
          } catch (e) { /* ignore write errors for readonly/disabled fields */ }
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
      
      // ── PHASE 3: Restore obligations (call addOb() for each row, then populate) ──
      if (data['__obligations'] && Array.isArray(data['__obligations'])) {
        setTimeout(function() {
          var obligations = data['__obligations'];
          var existingRows = document.querySelectorAll('.ob-row');
          var existingCount = existingRows.length;
          
          // Add missing rows
          for (var i = existingCount; i < obligations.length; i++) {
            if (typeof window.addOb === 'function') window.addOb();
          }
          
          // Wait for rows to be added, then populate
          setTimeout(function() {
            var rows = document.querySelectorAll('.ob-row');
            obligations.forEach(function (ob, idx) {
              if (idx >= rows.length) return;
              var row = rows[idx];
              var typeEl = row.querySelector('.ob-type');
              var bankEl = row.querySelector('.ob-bank');
              var emiEl = row.querySelector('.ob-emi');
              if (typeEl) typeEl.value = ob.type || '';
              if (bankEl) bankEl.value = ob.bank || '';
              if (emiEl) emiEl.value = ob.emi || '';
            });
            // Recalculate total
            if (typeof window.calcTotal === 'function') {
              setTimeout(function() { window.calcTotal(); }, 100);
            }
          }, 100);
        }, 200);
      }
      
      // ── PHASE 4: Restore Other Documents slots (recreate as view-only indicators) ──
      if (data['__otherDocs'] && Array.isArray(data['__otherDocs']) && typeof window.loadExistingOtherDocs === 'function') {
        // Convert to the format loadExistingOtherDocs expects (object with keys as doc names)
        var otherDocsObj = {};
        data['__otherDocs'].forEach(function(doc) {
          var displayName = doc.filename || doc.name || 'Document';
          otherDocsObj[doc.name] = displayName;
        });
        if (Object.keys(otherDocsObj).length > 0) {
          setTimeout(function() {
            window.loadExistingOtherDocs({ OTHER_DOCUMENTS: otherDocsObj });
          }, 150);
        }
      }
      
    }, 50); // Short delay for DOM updates
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

          // Last, so neither the snapshot nor the label matcher can put a lender
          // name a previous agent typed back into the facilitator field.
          applyLoanFacilitator();

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

  /* ── Loan Facilitator ───────────────────────────────────────────────────────
     Every application is facilitated by Ruralift itself, so this is not a box the
     agent fills in — it carries the firm's registered name and MSME number, and
     nothing else. Held here rather than in each form so the five copies cannot
     drift apart, and re-applied after an edit-mode restore for two reasons:

       · a lead saved before the field was fixed carries whatever the agent typed
         at the time (one had "FIVE STAR"), and reopening it must not bring that
         value back;
       · Chrome ignores autocomplete="off" on a plain text input and will offer a
         previously typed value, which a readonly field is never exposed to.   */
  var LOAN_FACILITATOR =
    '\uD83C\uDFE6 \u0930\u0942\u0930\u093E\u0932\u093F\u092B\u094D\u091F (MSME: UDYAM-MP-29-0021193)';
  function applyLoanFacilitator() {
    var el = document.getElementById('f_lender');
    if (!el) return;
    el.value = LOAN_FACILITATOR;
    // readonly, not disabled: a disabled field is left out when the form is
    // collected, which would drop the facilitator from the saved lead entirely.
    el.setAttribute('readonly', 'readonly');
    el.setAttribute('autocomplete', 'off');
    el.removeAttribute('placeholder');
    // Styled here rather than in five stylesheets, so it reads as settled rather
    // than as an empty box the agent forgot to fill in.
    el.style.background = '#f8fafc';
    el.style.cursor = 'default';
  }
  window.LOAN_FACILITATOR = LOAN_FACILITATOR;
  window.applyLoanFacilitator = applyLoanFacilitator;
  document.addEventListener('DOMContentLoaded', applyLoanFacilitator);

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
  // IMPORTANT: Does NOT overwrite fields that already have values (from snapshot).
  function prefillFromInfoFields(fields) {
    // Drop co-applicant / guarantor lines before any matching happens. They are
    // labelled with their owner ("Co-Applicant 1 Mobile"), and pass 2 matches on
    // containment — so "co applicant 1 mobile" contains the applicant's own
    // "mobile" label and would be written into the APPLICANT's field whenever that
    // field is still empty, silently attributing one person's details to another.
    // Party values are restored from the __parties snapshot instead.
    fields = (fields || []).filter(function (f) {
      return !/^\s*(co-?\s*applicant|guarantor)\b/i.test(String((f && f.label) || ''));
    });

    var entries = [];
    document.querySelectorAll('.fi').forEach(function (fi) {
      var labelEl = fi.querySelector('label');
      var input = fi.querySelector('input, select, textarea');
      if (!labelEl || !input || input.type === 'file') return;
      entries.push({ n: normLabel(labelEl.textContent), el: input });
    });
    var used = [];
    function take(el) { used.push(el); }
    function free(el) {
      if (used.indexOf(el) !== -1) return false;
      // Also skip fields that already have meaningful values (from snapshot)
      if (el.type === 'checkbox') return false; // checkboxes are always set (true/false)
      var val = el.value || '';
      if (el.tagName === 'SELECT') {
        // Skip selects that aren't at their default option
        var firstOpt = el.querySelector('option');
        return !val || (firstOpt && val === firstOpt.value);
      }
      return val.trim() === '';
    }

    // Pass 1 — exact normalised label match.
    fields.forEach(function (f) {
      if (f.heading || !f.value) return;
      var fn = normLabel(f.label);
      if (!fn) return;
      var hit = entries.find(function (e) { return free(e.el) && e.n === fn; });
      if (hit) { setFieldValue(hit.el, f.value); take(hit.el); }
    });
    // Pass 2 — one label is contained in the other (e.g. "Mobile" vs "Mobile number").
    // Require at least 4 chars to avoid "Name" matching "Full name" + "Father's name" + etc.
    fields.forEach(function (f) {
      if (f.heading || !f.value) return;
      var fn = normLabel(f.label);
      if (fn.length < 4) return;
      var hit = entries.find(function (e) {
        return free(e.el) && e.n.length >= 4 && (e.n.indexOf(fn) !== -1 || fn.indexOf(e.n) !== -1);
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
    // Wait for the POST to complete before navigating (prevents race condition)
    fetch('/api/agent/switch-form-type/' + encodeURIComponent(numberId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numberId: numberId, agentId: agentId, loanType: targetForm })
    }).finally(function () {
      location.href = '/forms/PLJOB-main/' + targetForm + '.html?numberId=' + encodeURIComponent(numberId) + '&agentId=' + encodeURIComponent(agentId);
    });
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
              // Skip internal tracking keys
              if (key.indexOf('__') === 0) return;
              
              var val = data[key];
              // Don't skip falsy values — 0 and false are legitimate!
              if (val === null || val === undefined) return;
              if (typeof val === 'string' && !val.trim()) return;
              
              var el = document.getElementById(key);
              if (!el || el.type === 'file') return;
              
              // Skip readonly/disabled fields (they're form-specific)
              if (el.readOnly || el.disabled) return;
              
              // Don't skip fields with values — selects and pre-filled fields should update too
              if (el.type === 'checkbox') el.checked = !!val;
              else el.value = val;
              fire(el);
            });
            
            // Restore obligations
            if (data['__obligations'] && Array.isArray(data['__obligations'])) {
              var obligations = data['__obligations'];
              for (var i = 0; i < obligations.length; i++) {
                if (typeof window.addOb === 'function') window.addOb();
              }
              setTimeout(function() {
                var rows = document.querySelectorAll('.ob-row');
                obligations.forEach(function (ob, idx) {
                  if (idx >= rows.length) return;
                  var row = rows[idx];
                  var typeEl = row.querySelector('.ob-type');
                  var bankEl = row.querySelector('.ob-bank');
                  var emiEl = row.querySelector('.ob-emi');
                  if (typeEl) typeEl.value = ob.type || '';
                  if (bankEl) bankEl.value = ob.bank || '';
                  if (emiEl) emiEl.value = ob.emi || '';
                });
                if (typeof window.calcTotal === 'function') window.calcTotal();
              }, 200);
            }
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
    // ── Explicit prefix mappings (match addFiles() calls exactly) ──
    'itr 3years':             'up_itr',          // PL_Business uses this prefix
    'owner 1 aadhaar':        'up_owner1_aadhaar',
    'owner 1 pan':            'up_owner1_pan',
    'owner 2 aadhaar':        'up_owner2_aadhaar',
    'owner 2 pan':            'up_owner2_pan',
    'owner other aadhaar':    'up_owner_other_aadhaar',
    'owner other pan':        'up_owner_other_pan',
    'soa statement always':   'up_soa_always',
    'permanent address proof':'up_perm_proof',
  };

  function normDocLabel(s) {
    return String(s || '').toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/\.[a-z]{2,5}$/, '')   // strip file extension
      .replace(/\s+\d+$/, '')          // strip trailing number ONLY if preceded by space (multi-file suffix)
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findUploadInput(docLabel, docFilename) {
    // Try candidates in order: label as-is, label without trailing digits, filename as-is, filename without digits
    var candidates = [
      normDocLabel(docLabel),
      normDocLabel(docLabel).replace(/\s*\d+$/, ''),
      normDocLabel(docFilename),
      normDocLabel(docFilename).replace(/\s*\d+$/, '')
    ];
    
    for (var c = 0; c < candidates.length; c++) {
      var norm = candidates[c];
      if (!norm) continue;
      
      // 1. Exact match
      if (DOC_TO_INPUT[norm]) {
        var inputId = DOC_TO_INPUT[norm];
        if (document.getElementById(inputId)) return inputId;
      }
    }
    
    // 2. Fuzzy substring match (longest key first to prefer specific matches)
    var keys = Object.keys(DOC_TO_INPUT).sort(function(a, b) { return b.length - a.length; });
    for (var c = 0; c < candidates.length; c++) {
      var norm = candidates[c];
      if (!norm) continue;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (norm.indexOf(key) !== -1 || key.indexOf(norm) !== -1) {
          var inputId = DOC_TO_INPUT[key];
          if (document.getElementById(inputId)) return inputId;
        }
      }
    }
    return null;
  }

  // Upload fields whose documents only make sense with a period attached.
  // 'month' → a single month/year (salary slips). 'range' → a from–to span
  // (bank statements). Anything not listed here keeps the plain chip display.
  // 'lender' for Statement of Account: an SOA is meaningless without knowing which
  // bank or NBFC the loan is with, and new lenders appear constantly so it has to be
  // typed in rather than picked from a list.
  // 'year' for ITR: three years are usually uploaded together and, numbered, there is
  // no way to tell which return is which.
  var META_INPUT_KIND = { up_salary: 'month', up_bank: 'range', up_soa: 'lender', up_itr: 'year' };

  // Assessment years offered for an ITR: this year back ten.
  function itrYearList() {
    var y = new Date().getFullYear();
    var out = [];
    for (var i = 0; i <= 10; i++) out.push(String(y - i));
    return out;
  }

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

  // Dates are written and shown as DD-MM-YYYY, the way they are read in India.
  // <input type="date"> only ever speaks ISO, so these convert between the two.
  function toDMY(iso) {
    var m = String(iso == null ? '' : iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : String(iso == null ? '' : iso);
  }
  function toISODate(dmy) {
    var m = String(dmy == null ? '' : dmy).match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : String(dmy == null ? '' : dmy);
  }
  window.__dmy = toDMY;

  // Pull an already-assigned period back out of a stored label so re-opening the
  // form shows what was set before instead of resetting the inputs to blank.
  function readPeriodFromLabel(label, kind) {
    var s = String(label || '').replace(/[_\s]+/g, ' ');
    if (kind === 'lender') {
      // "SOA HDFC Bank" -> "HDFC Bank". A bare "SOA Statement 2" has no lender yet.
      var t = s.replace(/^SOA\b/i, '').replace(/\bstatement\b/i, '').replace(/\s+/g, ' ').trim();
      if (!t || /^\d+$/.test(t)) return null;
      return { lender: t };
    }
    if (kind === 'year') {
      // "ITR 2024" -> 2024. The old default "ITR 3Years" carries no year.
      var y = s.match(/\b(19|20)\d{2}\b/);
      return y ? { year: y[0] } : null;
    }
    if (kind === 'month') {
      var m = s.match(new RegExp('(' + MONTH_NAMES.join('|') + ')\\s+(\\d{4})', 'i'));
      if (!m) return null;
      var name = MONTH_NAMES.filter(function (n) { return n.toLowerCase() === m[1].toLowerCase(); })[0];
      return { month: name, year: m[2] };
    }
    // DD-MM-YYYY first, then the ISO form older documents were labelled with, so
    // either way the editor still prefills with what was already set.
    var r = s.match(/(\d{2}-\d{2}-\d{4})\s*to\s*(\d{2}-\d{2}-\d{4})/i);
    if (r) return { from: toISODate(r[1]), to: toISODate(r[2]) };
    r = s.match(/(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/i);
    return r ? { from: r[1], to: r[2] } : null;
  }

  function buildDocPeriodRow(doc, shareToken, kind) {
    var viewUrl = '/share/' + encodeURIComponent(shareToken) + '/doc/' + encodeURIComponent(doc.id);
    var id = escapeHtml(doc.id);
    var current = readPeriodFromLabel(doc.label || doc.filename, kind);
    var isSet = !!current;

    // A co-applicant's / guarantor's document keeps its owner prefix when
    // relabelled — dropping it would rename their file to the applicant's naming
    // and collide with the applicant's own document of the same type.
    var ownerMatch = String(doc.filename || doc.label || '')
      .match(/^((?:coapplicant|guarantor)[ _]*\d+)[ _]/i);
    var ownerPrefix = ownerMatch ? ownerMatch[1].replace(/[ _]+/g, '') + '_' : '';

    // The filename is the whole point of this row — the agent has to be able to
    // tell which physical file they're labelling, so it leads at full size.
    var head = '<span style="display:inline-flex;align-items:center;gap:2px;background:#fff;border:1px solid #bbf7d0;border-radius:6px;overflow:hidden;max-width:100%">' +
      '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener" ' +
      'style="display:inline-flex;align-items:center;gap:5px;padding:5px 9px;color:#0c4a6e;text-decoration:none;font-size:13px;font-weight:700"' +
      ' onmouseover="this.style.background=\'#dcfce7\'" onmouseout="this.style.background=\'transparent\'" ' +
      'title="Open this document in a new tab">' +
      '\uD83D\uDCC4 ' + escapeHtml(doc.filename || doc.label) +
      '</a>' +
      renameBtnHtml(doc.id) +
      '<button type="button" onclick="window.__removeDoc(\'' + id + '\',this)" ' +
      'style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:transparent;border:none;border-left:1px solid #bbf7d0;color:#dc2626;font-size:13px;cursor:pointer;padding:0" ' +
      'onmouseover="this.style.background=\'#fef2f2\'" onmouseout="this.style.background=\'transparent\'" ' +
      'title="Remove this document">\u2715</button>' +
      '</span>';

    var status = '<span id="docmeta-status-' + id + '" style="font-size:11.5px;font-weight:700;color:' +
      (isSet ? '#15803d' : '#b45309') + '">' +
      (isSet ? '\u2705 period set' : '\u26A0 no period set') + '</span>';

    var controls;
    if (kind === 'year') {
      controls = '<label style="font-size:11.5px;font-weight:700;color:#0369a1">Year of this return' +
        '<select class="docmeta-year" style="display:block;margin-top:3px;padding:7px 10px;border:2px solid #38bdf8;' +
        'border-radius:8px;font-size:13px;font-weight:600;background:#fff;color:#0369a1;min-width:120px">' +
        '<option value="">Select year</option>' +
        itrYearList().map(function (y) {
          return '<option value="' + y + '"' + (current && current.year === y ? ' selected' : '') + '>' + y + '</option>';
        }).join('') + '</select></label>';
    } else if (kind === 'lender') {
      controls = '<label style="font-size:11.5px;font-weight:700;color:#0369a1;flex:1;min-width:200px">' +
        'Bank / NBFC this loan is with' +
        '<input type="text" class="docmeta-lender" value="' + escapeHtml(current ? current.lender : '') + '" ' +
        'placeholder="e.g. HDFC Bank, Bajaj Finance" ' +
        'style="display:block;margin-top:3px;width:100%;padding:7px 10px;border:2px solid #38bdf8;' +
        'border-radius:8px;font-size:13px;font-weight:600;font-family:inherit"></label>';
    } else if (kind === 'month') {
      var monthOpts = '<option value="">Select Month</option>' + MONTH_NAMES.map(function (m) {
        return '<option value="' + m + '"' + (current && current.month === m ? ' selected' : '') + '>' + m + '</option>';
      }).join('');
      var thisYear = new Date().getFullYear();
      var yearOpts = '<option value="">Year</option>';
      for (var y = thisYear; y >= thisYear - 3; y--) {
        yearOpts += '<option value="' + y + '"' + (current && current.year === String(y) ? ' selected' : '') + '>' + y + '</option>';
      }
      controls =
        '<select class="docmeta-month" style="padding:7px 10px;border:2px solid #38bdf8;border-radius:8px;font-size:13px;font-weight:600;background:#fff;color:#0369a1">' + monthOpts + '</select>' +
        '<select class="docmeta-year" style="padding:7px 10px;border:2px solid #38bdf8;border-radius:8px;font-size:13px;font-weight:600;background:#fff;color:#0369a1">' + yearOpts + '</select>';
    } else {
      controls =
        '<label style="font-size:11.5px;font-weight:700;color:#0369a1">From' +
        '<input type="date" class="docmeta-from" value="' + (current ? current.from : '') + '" ' +
        'style="display:block;margin-top:3px;padding:7px 10px;border:2px solid #38bdf8;border-radius:8px;font-size:13px;font-weight:600"></label>' +
        '<label style="font-size:11.5px;font-weight:700;color:#0369a1">To' +
        '<input type="date" class="docmeta-to" value="' + (current ? current.to : '') + '" ' +
        'style="display:block;margin-top:3px;padding:7px 10px;border:2px solid #38bdf8;border-radius:8px;font-size:13px;font-weight:600"></label>';
    }

    return '<div data-docrow="' + id + '" style="padding:11px 12px;background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:2px solid #bae6fd;border-radius:10px">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px">' + head + status + '</div>' +
      '<div id="docmeta-' + id + '" style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">' + controls +
      '<button type="button" onclick="window.__saveDocPeriod(\'' + id + '\',\'' + kind + '\',this,\'' +
      escapeHtml(ownerPrefix) + '\')" ' +
      'style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit">' +
      '\uD83D\uDCBE Save</button>' +
      '</div></div>';
  }

  // ── Assign a period to a document already on file ───────────────────────────
  // Renames the stored document instead of forcing a re-upload.
  window.__saveDocPeriod = function (docId, kind, btnEl, ownerPrefix) {
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    var agentId = p.get('agentId');
    if (!numberId) { alert('Cannot save: no lead ID in the URL.'); return; }

    var wrap = document.getElementById('docmeta-' + docId);
    if (!wrap) return;
    var prefix = ownerPrefix || '';

    var label;
    if (kind === 'year') {
      var yr1 = wrap.querySelector('.docmeta-year').value;
      if (!yr1) { alert('Pick the year this return is for.'); return; }
      label = prefix + 'ITR_' + yr1;
    } else if (kind === 'lender') {
      var lender = wrap.querySelector('.docmeta-lender').value.trim();
      if (!lender) { alert('Enter the bank or NBFC this statement belongs to.'); return; }
      if (/[<>:"/\\|?*]/.test(lender)) { alert('Avoid these characters: < > : " / \\ | ? *'); return; }
      label = prefix + 'SOA_' + lender.replace(/\s+/g, '_');
    } else if (kind === 'month') {
      var mo = wrap.querySelector('.docmeta-month').value;
      var yr = wrap.querySelector('.docmeta-year').value;
      if (!mo || !yr) { alert('Pick both a month and a year first.'); return; }
      label = prefix + 'Salary_Slip_' + mo + '_' + yr;
    } else {
      var from = wrap.querySelector('.docmeta-from').value;
      var to = wrap.querySelector('.docmeta-to').value;
      if (!from || !to) { alert('Pick both a FROM date and a TO date first.'); return; }
      if (from > to) { alert('The FROM date must be on or before the TO date.'); return; }
      label = prefix + 'Bank_Statement_' + toDMY(from) + '_to_' + toDMY(to);
    }

    var original = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.style.opacity = '0.5';
    btnEl.textContent = 'Saving\u2026';

    fetch('/api/agent/doc-label/' + encodeURIComponent(numberId) + '/' + encodeURIComponent(docId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId || '', label: label })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
        btnEl.textContent = original;
        if (d.error) { alert('Could not save the period: ' + d.error); return; }

        // Reflect the new name on the row so the change is visibly confirmed.
        var row = document.querySelector('[data-docrow="' + docId + '"]');
        if (row) {
          var link = row.querySelector('a');
          if (link) link.innerHTML = '\uD83D\uDCC4 ' + escapeHtml(d.filename || label);
        }
        var statusEl = document.getElementById('docmeta-status-' + docId);
        if (statusEl) {
          statusEl.textContent = '\u2705 saved';
          statusEl.style.color = '#15803d';
        }
      })
      .catch(function () {
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
        btnEl.textContent = original;
        alert('Network error while saving the period.');
      });
  };

  function markExistingDocs(docs, shareToken) {
    // A co-applicant's / guarantor's documents are handled first and removed from
    // the pool. They must not reach findUploadInput(), whose patterns would happily
    // match "CoApplicant1_Aadhaar_Card" to the applicant's own Aadhaar field and
    // show one person's document under another's name.
    var partyGrouped = {};
    docs = docs.filter(function (doc) {
      var pid = (typeof window.__findPartyUploadInput === 'function')
        ? window.__findPartyUploadInput(doc.label, doc.filename) : null;
      if (!pid) return true;
      if (!partyGrouped[pid]) partyGrouped[pid] = [];
      partyGrouped[pid].push(doc);
      return false;
    });
    markExistingPartyDocs(partyGrouped, shareToken);

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

      // Salary slips and bank statements are meaningless without a period, so those
      // two groups get an inline editor per document instead of a bare chip. Every
      // other document type keeps the compact chip layout.
      var metaKind = META_INPUT_KIND[inputId];

      if (metaKind) {
        html += '<div style="display:flex;flex-direction:column;gap:8px">';
        docList.forEach(function (doc) {
          html += buildDocPeriodRow(doc, shareToken, metaKind);
        });
        html += '</div>';
        html += '<div style="margin-top:7px;font-size:11px;color:#16a34a;font-style:italic">' +
          'Set the ' + (metaKind === 'month' ? 'month' : 'date range') + ' for each file and press Save \u00b7 ' +
          'Re-upload to replace \u00b7 Click \u2715 to remove a document</div>';
      } else {
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
            renameBtnHtml(doc.id) +
            '<button type="button" onclick="window.__removeDoc(\'' + escapeHtml(doc.id) + '\',this)" ' +
            'style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:transparent;border:none;border-left:1px solid #bbf7d0;color:#dc2626;font-size:13px;cursor:pointer;transition:all .15s;padding:0" ' +
            'onmouseover="this.style.background=\'#fef2f2\'" onmouseout="this.style.background=\'transparent\'" ' +
            'title="Remove this document">\u2715</button>' +
            '</span>';
        });
        html += '</div>';
        html += '<div style="margin-top:5px;font-size:11px;color:#16a34a;font-style:italic">Re-upload to replace \u00b7 Click \u2715 to remove a document</div>';
      }

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

    // Show unmatched docs in the "Other Documents" section
    var unmatchedDocs = docs.filter(function (doc) {
      return !findUploadInput(doc.label, doc.filename);
    });
    
    if (unmatchedDocs.length > 0 && typeof window.loadExistingOtherDocs === 'function') {
      // Let the form handle loading these as "Other Documents"
      try { window.loadExistingOtherDocs(unmatchedDocs, shareToken); } catch (e) {}
    }
    
    // Also show in banner as fallback
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
        // Remove the doc from the UI. Salary/bank documents render as a full row
        // (filename + period controls), so drop the whole row rather than just the
        // chip, which would otherwise leave orphaned month/date inputs behind.
        var chip = btnEl.closest('[data-docrow]') || btnEl.closest('span');
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

  /* ═══════════════════════════════════════════════════════════════════════════
     CO-APPLICANT / GUARANTOR PARTIES

     A case often carries a co-applicant, a guarantor, or both at once. Each of
     those people has their own identity details and their own documents
     (Aadhaar, PAN, photo, salary slips, bank statement, ITR, anything else) that
     must stay attributable to them rather than being mixed into the applicant's
     pile. This lives in the shared script so all five forms behave identically.

     Documents are written into the ZIP with the party baked into the FILENAME
     (CoApplicant1_Aadhaar_Card.pdf). That is deliberate: the server flattens ZIP
     folders when exploding an archive, and it derives a document's group key from
     the bare filename — so a co-applicant's "Aadhaar_Card.pdf" in a subfolder
     would collide with the applicant's and one would replace the other on merge.
     ═══════════════════════════════════════════════════════════════════════════ */

  var PARTY_ROLES = ['Co-Applicant', 'Guarantor'];

  var PARTY_FIELDS = [
    { key: 'name',     label: 'Full name',               type: 'text',     ph: 'As per PAN / Aadhaar', wide: true },
    { key: 'relation', label: 'Relation with applicant', type: 'text',     ph: 'e.g. Spouse, Father, Brother' },
    { key: 'dob',      label: 'Date of birth',           type: 'date' },
    { key: 'mobile',   label: 'Mobile',                  type: 'tel',      ph: '10-digit mobile' },
    { key: 'email',    label: 'Email',                   type: 'text',     ph: 'Optional' },
    { key: 'pan',      label: 'PAN number',              type: 'text',     ph: 'ABCDE1234F' },
    { key: 'aadhaar',  label: 'Aadhaar number',          type: 'text',     ph: '12 digits' },
    { key: 'emptype',  label: 'Employment type',         type: 'select',
      options: ['', 'Salaried', 'Self-employed / Business', 'Retired', 'Housewife', 'Student', 'Other'] },
    { key: 'company',  label: 'Company / Business name', type: 'text' },
    { key: 'income',   label: 'Monthly income (Rs.)',    type: 'number',   ph: '0' },
    { key: 'cibil',    label: 'CIBIL score',             type: 'number',   ph: 'e.g. 750' },
    { key: 'emi',      label: 'Existing EMI (Rs.)',      type: 'number',   ph: '0' },
    { key: 'addr',     label: 'Current address',         type: 'textarea', wide: true },
    { key: 'pin',      label: 'PIN code',                type: 'text',     ph: '6 digits' }
  ];

  // `file` is the filename stem used inside the ZIP. `period` mirrors the
  // applicant's own slips/statements: those are only meaningful with a month or a
  // date range attached, so the same prompts appear here.
  var PARTY_DOCS = [
    { key: 'aadhaar', label: 'Aadhaar Card',   file: 'Aadhaar_Card',   multi: true },
    { key: 'pan',     label: 'PAN Card',       file: 'PAN_Card',       multi: true },
    { key: 'photo',   label: 'Photograph',     file: 'Passport_Photo',  multi: false },
    { key: 'salary',  label: 'Salary Slips',   file: 'Salary_Slip',    multi: true, period: 'month' },
    { key: 'bank',    label: 'Bank Statement', file: 'Bank_Statement', multi: true, period: 'range' },
    { key: 'itr',     label: 'ITR',            file: 'ITR',            multi: true }
  ];

  var partyList = [];      // [{ role, slot }] in display order
  var partyPeriods = {};   // uploadInputId -> { fileIndex: {month,year} | {from,to} }
  var partyDocIndex = {};  // uploadInputId -> { party, doc } for change handlers
  var partyOtherSeq = {};  // partyKey -> last row number handed out
  var partyOtherRows = {}; // partyKey -> [rowNumber, …] currently on the page

  function partyKey(p)     { return (p.role === 'Guarantor' ? 'guarantor' : 'coapplicant') + p.slot; }
  function partyPrefix(p)  { return (p.role === 'Guarantor' ? 'Guarantor' : 'CoApplicant') + p.slot; }
  function partyTitle(p)   { return p.role + ' ' + p.slot; }
  function partyFieldId(p, k) { return 'pf_' + partyKey(p) + '_' + k; }
  function partyDocId(p, k)   { return 'up_' + partyKey(p) + '_' + k; }
  function partyPwId(p)       { return 'pw_' + partyKey(p); }

  function safeFileStem(s) {
    return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  }
  function padLabel(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  var PARTY_INPUT_CSS = 'width:100%;padding:9px 12px;border:1.5px solid #e5e7eb;border-radius:8px;' +
    'font-size:13.5px;font-family:inherit;color:#111827;background:#fff;outline:none;box-sizing:border-box';
  var PARTY_ADD_BTN_CSS = 'padding:10px 16px;background:#eef2ff;border:1.5px dashed #a5b4fc;border-radius:9px;' +
    'color:#4338ca;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit';

  function nextSlot(role) {
    var used = partyList.filter(function (p) { return p.role === role; })
                        .map(function (p) { return p.slot; });
    var n = 1;
    while (used.indexOf(n) !== -1) n++;
    return n;
  }

  // Builds the section chrome once. Forms only need to provide <div id="party-section">.
  function renderPartyShell() {
    var host = document.getElementById('party-section');
    if (!host || host.getAttribute('data-party-ready')) return host;
    host.setAttribute('data-party-ready', '1');
    host.className = 'sec';
    host.innerHTML =
      '<div class="sec-title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:17px;height:17px;flex-shrink:0">' +
        '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
        '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
        'Co-Applicant / Guarantor' +
        '<span class="chip">Optional \u00b7 add as many as needed</span>' +
      '</div>' +
      '<div style="font-size:12.5px;color:#4b5563;margin-bottom:14px;line-height:1.6">' +
        'Add anyone applying or guaranteeing alongside the main applicant. Each person keeps their own ' +
        'details and their own documents, and stays listed separately from the applicant\u2019s.' +
      '</div>' +
      '<div id="party-list"></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">' +
        '<button type="button" onclick="window.__addParty(\'Co-Applicant\')" style="' + PARTY_ADD_BTN_CSS + '">' +
        '+ Add Co-Applicant</button>' +
        '<button type="button" onclick="window.__addParty(\'Guarantor\')" style="' + PARTY_ADD_BTN_CSS + '">' +
        '+ Add Guarantor</button>' +
      '</div>';
    return host;
  }

  function partyFieldHtml(p, f) {
    var id = partyFieldId(p, f.key);
    var html = '<div style="' + (f.wide ? 'grid-column:1/-1' : '') + '">' +
      '<label for="' + id + '" style="display:block;font-size:12px;font-weight:600;color:#4b5563;margin-bottom:5px">' +
      escapeHtml(f.label) + '</label>';
    if (f.type === 'select') {
      html += '<select id="' + id + '" style="' + PARTY_INPUT_CSS + '">' +
        f.options.map(function (o) {
          return '<option value="' + escapeHtml(o) + '">' + escapeHtml(o || 'Select\u2026') + '</option>';
        }).join('') + '</select>';
    } else if (f.type === 'textarea') {
      html += '<textarea id="' + id + '" rows="2" placeholder="' + escapeHtml(f.ph || '') +
        '" style="' + PARTY_INPUT_CSS + ';resize:vertical"></textarea>';
    } else {
      html += '<input type="' + f.type + '" id="' + id + '" placeholder="' + escapeHtml(f.ph || '') +
        '" style="' + PARTY_INPUT_CSS + '">';
    }
    return html + '</div>';
  }

  function partyDocHtml(p, d) {
    var id = partyDocId(p, d.key);
    var hint = d.period === 'month' ? ' \u00b7 will ask for the month of each slip'
             : d.period === 'range' ? ' \u00b7 will ask for the date range'
             : d.multi ? ' \u00b7 multiple allowed' : '';
    return '<div style="padding:11px 12px;background:#fff;border:1.5px solid #e5e7eb;border-radius:9px">' +
      '<label for="' + id + '" style="display:block;font-size:12.5px;font-weight:700;color:#374151;margin-bottom:7px">' +
        escapeHtml(d.label) +
        '<span style="font-weight:400;color:#9ca3af;font-size:11px">' + hint + '</span>' +
      '</label>' +
      (d.named ? '<input type="text" id="' + id + '_name" placeholder="Name this document (e.g. Rent Agreement)" ' +
        'style="' + PARTY_INPUT_CSS + ';margin-bottom:7px">' : '') +
      '<input type="file" id="' + id + '"' + (d.multi ? ' multiple' : '') +
        ' onchange="window.__partyFileChange(\'' + id + '\')" style="font-size:12.5px;width:100%">' +
      '<div id="' + id + '_fn" style="display:none;font-size:12px;color:#16a34a;margin-top:6px;font-weight:600"></div>' +
      '<div id="' + id + '_period"></div>' +
      '<div id="' + id + '_existing"></div>' +
      '</div>';
  }

  function buildPartyCard(p) {
    var card = document.createElement('div');
    card.className = 'party-card';
    card.id = 'party-card-' + partyKey(p);
    card.setAttribute('data-party-role', p.role);
    card.setAttribute('data-party-slot', String(p.slot));
    card.style.cssText = 'position:relative;padding:16px;margin-bottom:14px;border:2px solid #c7d2fe;' +
      'border-radius:12px;background:linear-gradient(135deg,#f5f3ff,#eef2ff)';
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
        '<span style="font-size:13.5px;font-weight:800;color:#3730a3">' + escapeHtml(partyTitle(p)) + '</span>' +
        '<span style="font-size:11px;font-weight:700;color:#4338ca;background:#e0e7ff;padding:3px 9px;border-radius:20px">' +
          escapeHtml(partyPrefix(p)) + '</span>' +
        '<button type="button" onclick="window.__removeParty(\'' + partyKey(p) + '\')" ' +
          'style="margin-left:auto;padding:6px 12px;background:#fee2e2;border:none;border-radius:7px;' +
          'color:#dc2626;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Remove</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">' +
        PARTY_FIELDS.map(function (f) { return partyFieldHtml(p, f); }).join('') +
      '</div>' +
      '<div style="font-size:12px;font-weight:800;color:#3730a3;text-transform:uppercase;letter-spacing:.4px;' +
        'margin:0 0 9px;padding-top:12px;border-top:1.5px dashed #c7d2fe">' +
        'Their documents' +
      '</div>' +
      '<div style="display:grid;gap:10px">' +
        PARTY_DOCS.map(function (d) { return partyDocHtml(p, d); }).join('') +
      '</div>' +
      // Anything beyond the standard set. Each entry is named on its own, because
      // one shared name for a whole multi-select tells you nothing about which file
      // is which once they are all sitting in the ZIP together.
      '<div style="margin-top:10px;padding:11px 12px;background:#fff;border:1.5px solid #e5e7eb;border-radius:9px">' +
        '<div style="font-size:12.5px;font-weight:700;color:#374151;margin-bottom:8px">Other documents' +
          '<span style="font-weight:400;color:#9ca3af;font-size:11px"> \u00b7 name each one separately</span></div>' +
        '<div id="otherlist_' + partyKey(p) + '"></div>' +
        '<div id="up_' + partyKey(p) + '_other_existing"></div>' +
        '<button type="button" onclick="window.__addPartyOtherDoc(\'' + partyKey(p) + '\')" ' +
          'style="margin-top:8px;padding:8px 14px;background:#eef2ff;border:1.5px dashed #a5b4fc;' +
          'border-radius:8px;color:#4338ca;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit">' +
          '+ Add another document</button>' +
      '</div>' +
      '<div style="margin-top:10px;display:flex;align-items:center;gap:9px;flex-wrap:wrap">' +
        '<label for="' + partyPwId(p) + '" style="font-size:12px;font-weight:600;color:#4b5563">' +
          '\uD83D\uDD10 PDF password (if their PDFs are locked)</label>' +
        '<input type="password" id="' + partyPwId(p) + '" placeholder="Leave blank if none" ' +
          'style="' + PARTY_INPUT_CSS + ';flex:1;min-width:190px">' +
      '</div>';
    return card;
  }

  function registerPartyDocs(p) {
    PARTY_DOCS.forEach(function (d) { partyDocIndex[partyDocId(p, d.key)] = { party: p, doc: d }; });
  }

  function partyByKey(key) {
    for (var i = 0; i < partyList.length; i++) {
      if (partyKey(partyList[i]) === key) return partyList[i];
    }
    return null;
  }

  // One extra document for a party, with its own name. Returns the row number.
  window.__addPartyOtherDoc = function (key, presetName) {
    var p = partyByKey(key);
    var host = document.getElementById('otherlist_' + key);
    if (!p || !host) return null;

    var n = (partyOtherSeq[key] = (partyOtherSeq[key] || 0) + 1);
    if (!partyOtherRows[key]) partyOtherRows[key] = [];
    partyOtherRows[key].push(n);

    var fileId = 'up_' + key + '_other' + n;
    var nameId = 'pn_' + key + '_' + n;
    partyDocIndex[fileId] = { party: p, doc: { key: 'other' + n, label: 'Other document', file: 'Other_Document' } };

    var row = document.createElement('div');
    row.id = 'otherrow_' + key + '_' + n;
    row.style.cssText = 'padding:10px;margin-bottom:8px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px';
    // File first, name second. Asking for a name before anything is attached gives
    // the agent nothing to describe, so the name field only appears once a file is
    // chosen (or straight away when a stored name is being restored).
    var hasPreset = !!(presetName && presetName.trim());
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="file" id="' + fileId + '" multiple ' +
          'onchange="window.__partyFileChange(\'' + fileId + '\')" style="flex:1;font-size:12.5px">' +
        '<button type="button" onclick="window.__removePartyOtherDoc(\'' + key + '\',' + n + ')" ' +
          'style="padding:7px 11px;background:#fee2e2;border:none;border-radius:7px;color:#dc2626;' +
          'font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">Remove</button>' +
      '</div>' +
      '<div id="' + fileId + '_fn" style="display:none;font-size:12px;color:#16a34a;margin-top:6px;font-weight:600"></div>' +
      '<div id="' + fileId + '_namewrap" style="' + (hasPreset ? '' : 'display:none;') + 'margin-top:7px">' +
        '<label for="' + nameId + '" style="display:block;font-size:11.5px;font-weight:700;color:#4338ca;' +
          'margin-bottom:4px">Name this document</label>' +
        '<input type="text" id="' + nameId + '" placeholder="e.g. Rent Agreement" ' +
          'value="' + escapeHtml(presetName || '') + '" style="' + PARTY_INPUT_CSS + '">' +
      '</div>' +
      '<div id="' + fileId + '_period"></div>';
    host.appendChild(row);
    return n;
  };

  window.__removePartyOtherDoc = function (key, n) {
    var row = document.getElementById('otherrow_' + key + '_' + n);
    if (row && !confirm('Remove this document?')) return;
    if (row) row.remove();
    delete partyDocIndex['up_' + key + '_other' + n];
    delete partyPeriods['up_' + key + '_other' + n];
    var list = partyOtherRows[key] || [];
    var i = list.indexOf(n);
    if (i !== -1) list.splice(i, 1);
  };

  // [{ n, name, input }] for a party's extra documents, in the order shown.
  function partyOtherEntries(key) {
    return (partyOtherRows[key] || []).map(function (n) {
      var nameEl = document.getElementById('pn_' + key + '_' + n);
      return {
        n: n,
        name: nameEl ? nameEl.value.trim() : '',
        input: document.getElementById('up_' + key + '_other' + n)
      };
    });
  }

  function addParty(role, forcedSlot) {
    if (PARTY_ROLES.indexOf(role) === -1) role = 'Co-Applicant';
    renderPartyShell();
    var list = document.getElementById('party-list');
    if (!list) return null;
    var slot = forcedSlot;
    if (!slot || partyList.some(function (p) { return p.role === role && p.slot === slot; })) {
      slot = nextSlot(role);
    }
    var p = { role: role, slot: slot };
    partyList.push(p);
    registerPartyDocs(p);
    list.appendChild(buildPartyCard(p));
    return p;
  }

  window.__addParty = function (role) { addParty(role); };

  window.__removeParty = function (key) {
    var idx = -1;
    for (var i = 0; i < partyList.length; i++) {
      if (partyKey(partyList[i]) === key) { idx = i; break; }
    }
    if (idx === -1) return;
    var p = partyList[idx];
    var label = partyTitle(p);
    if (!confirm('Remove ' + label + ' and everything entered for them?')) return;
    PARTY_DOCS.forEach(function (d) {
      var id = partyDocId(p, d.key);
      delete partyPeriods[id];
      delete partyDocIndex[id];
    });
    (partyOtherRows[key] || []).forEach(function (n) {
      delete partyPeriods['up_' + key + '_other' + n];
      delete partyDocIndex['up_' + key + '_other' + n];
    });
    delete partyOtherRows[key];
    delete partyOtherSeq[key];
    partyList.splice(idx, 1);
    var card = document.getElementById('party-card-' + key);
    if (card) card.remove();
  };

  // Month/date prompts for a party's slips and statements, mirroring the
  // applicant's own so their documents are identifiable by period too.
  window.__partyFileChange = function (inputId) {
    var meta = partyDocIndex[inputId];
    var inp = document.getElementById(inputId);
    if (!meta || !inp) return;
    var fnEl = document.getElementById(inputId + '_fn');
    var perEl = document.getElementById(inputId + '_period');
    var files = inp.files ? Array.prototype.slice.call(inp.files) : [];

    if (fnEl) {
      fnEl.textContent = files.length ? '\u2705 ' + files.map(function (f) { return f.name; }).join(', ') : '';
      fnEl.style.display = files.length ? 'block' : 'none';
    }
    // An extra document is named after its file is attached, so reveal that field now.
    var nameWrap = document.getElementById(inputId + '_namewrap');
    if (nameWrap) {
      nameWrap.style.display = files.length ? 'block' : 'none';
      if (files.length) {
        var nameField = nameWrap.querySelector('input');
        if (nameField && !nameField.value.trim()) nameField.focus();
      }
    }

    partyPeriods[inputId] = {};
    if (!perEl) return;
    perEl.innerHTML = '';
    if (!meta.doc.period || !files.length) return;

    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:9px;padding:11px;background:#eff6ff;border:1.5px solid #93c5fd;border-radius:9px';
    wrap.innerHTML = '<div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:8px">' +
      (meta.doc.period === 'month'
        ? '\uD83D\uDCC5 Which month does each slip belong to?'
        : '\uD83D\uDCC5 What period does each statement cover?') + '</div>';

    files.forEach(function (f, i) {
      partyPeriods[inputId][i] = {};
      var row = document.createElement('div');
      row.style.cssText = 'padding:9px;background:#fff;border:1px solid #bfdbfe;border-radius:7px;margin-bottom:7px';
      var head = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">' +
        '<div style="flex:1;font-size:12.5px;font-weight:700;color:#0c4a6e;overflow:hidden;' +
        'text-overflow:ellipsis">\uD83D\uDCC4 ' + escapeHtml(f.name) + '</div>' +
        selectedFileRemoveBtn(inputId, i) + '</div>';
      if (meta.doc.period === 'month') {
        var thisYear = new Date().getFullYear();
        var years = '';
        for (var y = thisYear; y >= thisYear - 3; y--) years += '<option value="' + y + '">' + y + '</option>';
        row.innerHTML = head + '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<select data-party-per="month" style="' + PARTY_INPUT_CSS + ';flex:1;min-width:130px">' +
            '<option value="">Select Month</option>' +
            MONTH_NAMES.map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') +
          '</select>' +
          '<select data-party-per="year" style="' + PARTY_INPUT_CSS + ';flex:0 0 110px">' +
            '<option value="">Year</option>' + years +
          '</select></div>';
      } else {
        row.innerHTML = head + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">' +
          '<div><label style="display:block;font-size:11px;font-weight:700;color:#0369a1;margin-bottom:4px">FROM</label>' +
            '<input type="date" data-party-per="from" style="' + PARTY_INPUT_CSS + '"></div>' +
          '<div><label style="display:block;font-size:11px;font-weight:700;color:#0369a1;margin-bottom:4px">TO</label>' +
            '<input type="date" data-party-per="to" style="' + PARTY_INPUT_CSS + '"></div></div>';
      }
      row.querySelectorAll('[data-party-per]').forEach(function (ctrl) {
        ctrl.addEventListener('change', function () {
          partyPeriods[inputId][i][ctrl.getAttribute('data-party-per')] = ctrl.value;
        });
      });
      wrap.appendChild(row);
    });
    perEl.appendChild(wrap);
  };

  function partyHasContent(item) {
    if (Object.keys(item.fields).some(function (k) { return item.fields[k]; })) return true;
    if (PARTY_DOCS.some(function (d) {
      var inp = document.getElementById('up_' + item.key + '_' + d.key);
      return inp && inp.files && inp.files.length > 0;
    })) return true;
    return partyOtherEntries(item.key).some(function (e) {
      return e.name || (e.input && e.input.files && e.input.files.length > 0);
    });
  }

  function collectParties() {
    return partyList.map(function (p) {
      var fields = {};
      PARTY_FIELDS.forEach(function (f) {
        var el = document.getElementById(partyFieldId(p, f.key));
        fields[f.key] = el ? String(el.value == null ? '' : el.value).trim() : '';
      });
      var docNames = {};
      PARTY_DOCS.forEach(function (d) {
        if (!d.named) return;
        var el = document.getElementById(partyDocId(p, d.key) + '_name');
        if (el && el.value.trim()) docNames[d.key] = el.value.trim();
      });
      // Names of the extra document rows, so reopening the form brings them back.
      var otherDocs = partyOtherEntries(partyKey(p))
        .filter(function (e) { return e.name || (e.input && e.input.files && e.input.files.length); })
        .map(function (e) { return { name: e.name }; });
      return {
        role: p.role, slot: p.slot, key: partyKey(p), prefix: partyPrefix(p),
        fields: fields, docNames: docNames, otherDocs: otherDocs
      };
    });
  }

  window.__collectParties = function () {
    return collectParties().filter(partyHasContent);
  };

  // Rebuilt synchronously from the snapshot: markExistingDocs() runs immediately
  // after applyFormSnapshot() returns, so these upload inputs have to exist by
  // then or a party's stored documents would have nowhere to attach.
  window.__restoreParties = function (list) {
    if (!Array.isArray(list) || !list.length) return;
    renderPartyShell();
    var host = document.getElementById('party-list');
    if (!host) return;
    host.innerHTML = '';
    partyList = [];
    partyPeriods = {};
    partyDocIndex = {};
    partyOtherSeq = {};
    partyOtherRows = {};
    list.forEach(function (item) {
      if (!item) return;
      var role = PARTY_ROLES.indexOf(item.role) !== -1 ? item.role : 'Co-Applicant';
      var p = addParty(role, Number(item.slot) || 0);
      if (!p) return;
      var fields = item.fields || {};
      PARTY_FIELDS.forEach(function (f) {
        var el = document.getElementById(partyFieldId(p, f.key));
        if (el && fields[f.key] != null) el.value = fields[f.key];
      });
      var names = item.docNames || {};
      Object.keys(names).forEach(function (k) {
        var el = document.getElementById(partyDocId(p, k) + '_name');
        if (el) el.value = names[k];
      });
      // Recreate each extra document row so its name comes back with it.
      (item.otherDocs || []).forEach(function (od) {
        if (typeof window.__addPartyOtherDoc === 'function') {
          window.__addPartyOtherDoc(partyKey(p), (od && od.name) || '');
        }
      });
    });
  };

  // Writes every party's files into the ZIP, party baked into each filename.
  // `unlockPdf` is handed in by the calling form because each form owns its own
  // implementation (PL_* nest it inside saveFile, BL/LAP declare it globally).
  window.__addPartyDocsToZip = async function (zip, unlockPdf) {
    if (!zip || !partyList.length) return 0;
    var folder = (typeof zip.folder === 'function') ? zip.folder('Documents') : zip;
    var written = 0;

    for (var i = 0; i < partyList.length; i++) {
      var p = partyList[i];
      var prefix = partyPrefix(p);
      var pwEl = document.getElementById(partyPwId(p));
      var pw = pwEl ? String(pwEl.value || '').trim() : '';

      for (var j = 0; j < PARTY_DOCS.length; j++) {
        var d = PARTY_DOCS[j];
        var inputId = partyDocId(p, d.key);
        var inp = document.getElementById(inputId);
        if (!inp || !inp.files || !inp.files.length) continue;

        var stem = d.file;
        if (d.named) {
          var nameEl = document.getElementById(inputId + '_name');
          var custom = nameEl ? safeFileStem(nameEl.value) : '';
          if (custom) stem = custom;
        }
        var periods = partyPeriods[inputId] || {};

        for (var k = 0; k < inp.files.length; k++) {
          var f = inp.files[k];
          var dot = f.name.lastIndexOf('.');
          var ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '';
          var per = periods[k] || {};
          var namePart;
          if (d.period === 'month' && per.month && per.year) {
            namePart = stem + '_' + per.month + '_' + per.year;
          } else if (d.period === 'range' && per.from && per.to) {
            namePart = stem + '_' + toDMY(per.from) + '_to_' + toDMY(per.to);
          } else {
            namePart = stem + (inp.files.length > 1 ? '_' + (k + 1) : '');
          }
          var out = f;
          if (pw && ext === '.pdf' && typeof unlockPdf === 'function') {
            try { out = await unlockPdf(f, pw); } catch (e) { out = f; }
          }
          folder.file(prefix + '_' + namePart + ext, out);
          written++;
        }
      }

      // Their extra documents, each under the name given to that row.
      var entries = partyOtherEntries(partyKey(p));
      for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        if (!entry.input || !entry.input.files || !entry.input.files.length) continue;
        var otherStem = safeFileStem(entry.name) || ('Other_Document_' + entry.n);
        for (var q = 0; q < entry.input.files.length; q++) {
          var ef = entry.input.files[q];
          var edot = ef.name.lastIndexOf('.');
          var eext = edot > 0 ? ef.name.slice(edot).toLowerCase() : '';
          var eName = otherStem + (entry.input.files.length > 1 ? '_' + (q + 1) : '');
          var eOut = ef;
          if (pw && eext === '.pdf' && typeof unlockPdf === 'function') {
            try { eOut = await unlockPdf(ef, pw); } catch (err) { eOut = ef; }
          }
          folder.file(prefix + '_' + eName + eext, eOut);
          written++;
        }
      }
    }
    return written;
  };

  // Lines spliced into Applicant_Info.txt. Labels are deliberately prefixed with
  // the party's title: the server's label->field map turns a bare "Full name"
  // into the applicant's f_name, so an unprefixed party label would overwrite the
  // applicant's own details when an older lead is reconstructed from this text.
  window.__partyInfoLines = function () {
    var parties = collectParties().filter(partyHasContent);
    if (!parties.length) return ['  None declared'];

    var lines = [];
    parties.forEach(function (item, idx) {
      if (idx) lines.push('');
      var title = item.role + ' ' + item.slot;
      lines.push(title + (item.fields.name ? ' \u2014 ' + item.fields.name : ''));

      PARTY_FIELDS.forEach(function (f) {
        var v = item.fields[f.key];
        if (!v) return;
        lines.push('  ' + padLabel(title + ' ' + f.label, 34) + ': ' + v);
      });

      var docBits = [];
      PARTY_DOCS.forEach(function (d) {
        var inp = document.getElementById('up_' + item.key + '_' + d.key);
        if (!inp || !inp.files || !inp.files.length) return;
        var name = (d.named && item.docNames[d.key]) ? item.docNames[d.key] : d.label;
        docBits.push(name + ' (' + inp.files.length + ')');
      });
      partyOtherEntries(item.key).forEach(function (e) {
        if (!e.input || !e.input.files || !e.input.files.length) return;
        docBits.push((e.name || 'Other document') + ' (' + e.input.files.length + ')');
      });
      lines.push('  ' + padLabel(title + ' documents', 34) + ': ' +
        (docBits.length ? docBits.join(', ') : 'None uploaded'));
    });
    return lines;
  };

  // Routes a stored document back to the party upload field it came from, so a
  // party's existing files show up under that party in edit mode instead of
  // falling through to the applicant's fields or the Other Documents bucket.
  window.__findPartyUploadInput = function (label, filename) {
    var src = String(filename || label || '');
    var m = src.match(/^(coapplicant|guarantor)[ _]*(\d+)[ _]+(.+)$/i);
    if (!m) return null;
    var key = m[1].toLowerCase() + m[2];
    var rest = m[3].replace(/\.[^.]+$/, '').replace(/[\s]+/g, '_').toLowerCase();

    // Longest stem wins so Passport_Photo isn't shadowed by a shorter match.
    var best = null;
    PARTY_DOCS.forEach(function (d) {
      var stem = d.file.toLowerCase();
      if (rest.indexOf(stem) === 0 && (!best || stem.length > best.len)) {
        best = { key: d.key, len: stem.length };
      }
    });
    if (best) {
      var id = 'up_' + key + '_' + best.key;
      return document.getElementById(id) ? id : null;
    }
    // Not one of the standard types, so it is one of their extra documents. Those
    // rows are named freely and can't be matched by stem, so existing files are
    // listed together under the party's own "Other documents" area.
    return document.getElementById('up_' + key + '_other_existing') ? ('up_' + key + '_other') : null;
  };

  // Which period editor a party upload field needs, for existing-document rows.
  window.__partyPeriodKind = function (inputId) {
    var meta = partyDocIndex[inputId];
    return meta && meta.doc.period ? meta.doc.period : null;
  };

  // Renders "already on file" under each party upload field. Party fields aren't
  // wrapped in the forms' .ub upload chrome, so they get their own renderer that
  // targets the per-field <div id="<inputId>_existing"> slot.
  function markExistingPartyDocs(grouped, shareToken) {
    Object.keys(grouped).forEach(function (inputId) {
      var slot = document.getElementById(inputId + '_existing');
      if (!slot) return;
      var list = grouped[inputId];
      var kind = (typeof window.__partyPeriodKind === 'function') ? window.__partyPeriodKind(inputId) : null;

      var html = '<div style="margin-top:8px;padding:9px 11px;background:linear-gradient(135deg,#ecfdf5,#f0fdf4);' +
        'border:1.5px solid #86efac;border-radius:9px">' +
        '<div style="font-weight:700;font-size:12px;color:#166534;margin-bottom:6px">\u2705 Already on file' +
        (list.length > 1 ? ' (' + list.length + ' files)' : '') + '</div>';

      if (kind) {
        // Slips and statements get the same period editor as the applicant's, so a
        // party's undated files can be labelled without re-uploading them.
        html += '<div style="display:flex;flex-direction:column;gap:8px">';
        list.forEach(function (doc) { html += buildDocPeriodRow(doc, shareToken, kind); });
        html += '</div>';
      } else {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        list.forEach(function (doc) {
          var viewUrl = '/share/' + encodeURIComponent(shareToken) + '/doc/' + encodeURIComponent(doc.id);
          html += '<span style="display:inline-flex;align-items:center;background:#fff;border:1px solid #bbf7d0;' +
            'border-radius:6px;overflow:hidden">' +
            '<a href="' + escapeHtml(viewUrl) + '" target="_blank" rel="noopener" ' +
            'style="padding:4px 8px;color:#15803d;text-decoration:none;font-size:11.5px;font-weight:600">' +
            '\uD83D\uDCC4 ' + escapeHtml(doc.filename || doc.label) + '</a>' +
            renameBtnHtml(doc.id) +
            '<button type="button" onclick="window.__removeDoc(\'' + escapeHtml(doc.id) + '\',this)" ' +
            'style="width:24px;height:24px;background:transparent;border:none;border-left:1px solid #bbf7d0;' +
            'color:#dc2626;font-size:13px;cursor:pointer;padding:0" title="Remove this document">\u2715</button>' +
            '</span>';
        });
        html += '</div>';
      }

      html += '<div style="margin-top:6px;font-size:11px;color:#16a34a;font-style:italic">' +
        'Re-upload to replace \u00b7 Click \u2715 to remove</div></div>';
      slot.innerHTML = html;
    });
  }

  document.addEventListener('DOMContentLoaded', function () { renderPartyShell(); });

  /* ═══════════════════════════════════════════════════════════════════════════
     "OTHER DOCUMENTS" -> WHICH SECTION DO THEY BELONG TO

     A custom document always belongs to somebody or to some section — a property
     paper, an income proof, applicant KYC, a co-owner, a co-applicant. Naming it
     alone left it stranded in a generic "Other Documents" pile on the view page.
     Each slot now carries a section dropdown, and the choice is encoded into the
     ZIP filename as a "Cat-<slug>_" prefix (or the party's own prefix), because
     the server flattens ZIP folders and can only read the filename.

     The dropdown is injected from here rather than editing five different
     "Other Documents" implementations — two are written out longhand and three are
     minified one-liners, so a shared observer is both smaller and safer.
     ═══════════════════════════════════════════════════════════════════════════ */

  var OTHER_DOC_SECTIONS = [
    { value: '',            label: 'Other Documents (unassigned)' },
    { value: 'kyc',         label: 'Applicant KYC Documents' },
    { value: 'income',      label: 'Income & Financial Documents' },
    { value: 'business',    label: 'Business Documents' },
    { value: 'property',    label: 'Property Documents' },
    { value: 'ownerfather', label: 'Property Owner / Father KYC' },
    { value: 'ownermother', label: 'Property Owner / Mother KYC' },
    { value: 'ownerother',  label: 'Other Property Owner KYC' },
    { value: 'spouse',      label: 'Spouse Documents' }
  ];

  // Parties currently on the form are offered too, so a document can be filed
  // directly under the co-applicant or guarantor it belongs to.
  function otherDocSectionOptions() {
    var opts = OTHER_DOC_SECTIONS.slice();
    partyList.forEach(function (p) {
      opts.push({ value: 'party:' + partyPrefix(p), label: partyTitle(p) + (function () {
        var el = document.getElementById(partyFieldId(p, 'name'));
        return (el && el.value.trim()) ? ' \u2014 ' + el.value.trim() : '';
      })() });
    });
    return opts;
  }

  function normaliseOtherDocRowId(rawId) {
    var id = String(rawId == null ? '' : rawId);
    return /^other-doc-/.test(id) ? id : 'other-doc-' + id;
  }

  // Filename prefix for a slot's chosen section. Called by each form's ZIP builder.
  window.__otherDocPrefix = function (rawId) {
    var sel = document.getElementById(normaliseOtherDocRowId(rawId) + '-cat');
    var v = sel ? sel.value : '';
    if (!v) return '';
    if (v.indexOf('party:') === 0) return v.slice(6) + '_';
    return 'Cat-' + v + '_';
  };

  window.__otherDocSection = function (rawId) {
    var sel = document.getElementById(normaliseOtherDocRowId(rawId) + '-cat');
    return sel ? sel.value : '';
  };

  function injectOtherDocSection(row) {
    if (!row || row.querySelector('[data-otherdoc-cat]')) return;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    var opts = otherDocSectionOptions().map(function (o) {
      return '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>';
    }).join('');
    wrap.innerHTML =
      '<label for="' + row.id + '-cat" style="font-size:11.5px;font-weight:700;color:#4338ca">' +
        'Show under section:</label>' +
      '<select id="' + row.id + '-cat" data-otherdoc-cat="1" style="flex:1;min-width:210px;padding:7px 10px;' +
        'border:1.5px solid #a5b4fc;border-radius:8px;font-size:12.5px;font-family:inherit;background:#fff;' +
        'color:#3730a3;font-weight:600">' + opts + '</select>';
    row.appendChild(wrap);
  }

  function watchOtherDocRows() {
    ['other-docs-container', 'other-docs-wrapper'].forEach(function (hostId) {
      var host = document.getElementById(hostId);
      if (!host || host.getAttribute('data-cat-watch')) return;
      host.setAttribute('data-cat-watch', '1');
      // Catch rows that already exist, then anything added later.
      Array.prototype.forEach.call(host.children, function (el) {
        if (/^other-doc-\d+$/.test(el.id || '')) injectOtherDocSection(el);
      });
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          Array.prototype.forEach.call(m.addedNodes, function (n) {
            if (n.nodeType === 1 && /^other-doc-\d+$/.test(n.id || '')) injectOtherDocSection(n);
          });
        });
      }).observe(host, { childList: true });
    });
  }

  document.addEventListener('DOMContentLoaded', function () { watchOtherDocRows(); });

  /* ═══════════════════════════════════════════════════════════════════════════
     STATEMENT OF ACCOUNT -> WHICH LENDER

     An SOA only means something next to the loan it belongs to, and several can be
     uploaded at once for different lenders. New banks and NBFCs appear constantly,
     so the lender is typed in per file rather than chosen from a list that would go
     stale. Each file lands in the ZIP as SOA_<Lender>, and the same lender field is
     offered on documents already on file (META_INPUT_KIND marks up_soa as 'lender').

     Wired up from here, listening on the field, so the five forms need no markup
     change beyond swapping their SOA line in the ZIP builder.
     ═══════════════════════════════════════════════════════════════════════════ */

  /* ── Dropping one wrongly-picked file ──────────────────────────────────────
     A file input's FileList is read-only, so removing a single selection means
     rebuilding the list through a DataTransfer and assigning it back. Dispatching
     'change' afterwards lets whatever rendered the metadata rows redraw itself. If
     the browser has no DataTransfer, clearing the field is the honest fallback. */
  window.__removeSelectedFile = function (inputId, index) {
    var inp = document.getElementById(inputId);
    if (!inp || !inp.files || !inp.files.length) return;
    var keep = Array.prototype.filter.call(inp.files, function (f, i) { return i !== index; });
    try {
      var dt = new DataTransfer();
      keep.forEach(function (f) { dt.items.add(f); });
      inp.files = dt.files;
    } catch (e) {
      if (!confirm('This browser cannot drop a single file. Clear all selected files instead?')) return;
      inp.value = '';
    }
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Small ✕ for a row that represents one selected (not yet saved) file.
  function selectedFileRemoveBtn(inputId, index, extraStyle) {
    return '<button type="button" onclick="window.__removeSelectedFile(\'' + inputId + '\',' + index + ')" ' +
      'title="Remove this file" style="flex:0 0 auto;width:26px;height:26px;border:none;border-radius:7px;' +
      'background:#fee2e2;color:#dc2626;font-size:14px;font-weight:700;cursor:pointer;padding:0;line-height:1;' +
      (extraStyle || '') + '">\u2715</button>';
  }
  window.__fileRemoveBtnHtml = selectedFileRemoveBtn;

  var soaLenders = {};   // file index -> lender typed for that file

  function renderSoaLenders() {
    var inp = document.getElementById('up_soa');
    var box = document.getElementById('soa-lender-container');
    if (!inp || !box) return;
    var files = inp.files ? Array.prototype.slice.call(inp.files) : [];
    soaLenders = {};
    box.innerHTML = '';
    if (!files.length) return;

    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px;padding:13px;background:#eff6ff;border:2px solid #3b82f6;border-radius:10px';
    wrap.innerHTML = '<div style="font-size:13px;font-weight:700;color:#1e40af;margin-bottom:4px">' +
      '\uD83C\uDFE6 Which lender does each statement belong to?</div>' +
      '<p style="margin:0 0 10px;font-size:11.5px;color:#1e3a8a">' +
      'Type the bank or NBFC for each file so every SOA is identifiable.</p>';

    files.forEach(function (f, i) {
      soaLenders[i] = '';
      var row = document.createElement('div');
      row.style.cssText = 'padding:10px;background:#fff;border:1.5px solid #bfdbfe;border-radius:8px;margin-bottom:8px';
      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<div style="flex:1;font-size:12.5px;font-weight:700;color:#0c4a6e;overflow:hidden;' +
            'text-overflow:ellipsis">\uD83D\uDCC4 ' + escapeHtml(f.name) + '</div>' +
          selectedFileRemoveBtn('up_soa', i) +
        '</div>' +
        '<input type="text" data-soa-lender="' + i + '" placeholder="Bank / NBFC name (e.g. HDFC Bank, Bajaj Finance)" ' +
          'style="width:100%;padding:8px 11px;border:2px solid #38bdf8;border-radius:8px;font-size:13px;' +
          'font-weight:600;font-family:inherit;box-sizing:border-box">';
      var field = row.querySelector('[data-soa-lender]');
      if (field) {
        field.addEventListener('input', function () { soaLenders[i] = field.value.trim(); });
      }
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  function watchSoaField() {
    var inp = document.getElementById('up_soa');
    if (!inp || inp.getAttribute('data-soa-watch')) return;
    inp.setAttribute('data-soa-watch', '1');
    // A container is created next to the field rather than added to five templates.
    if (!document.getElementById('soa-lender-container')) {
      var box = document.createElement('div');
      box.id = 'soa-lender-container';
      var anchor = inp.closest('.ub') || inp;
      if (anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    // Added alongside the form's own inline onchange, which still runs.
    inp.addEventListener('change', renderSoaLenders);
  }

  document.addEventListener('DOMContentLoaded', function () { watchSoaField(); });

  /* ═══════════════════════════════════════════════════════════════════════════
     ITR -> WHICH YEAR

     "ITR — Last 3 Years" means three returns are normally attached at once, and
     numbered ITR_3Years_1/_2/_3 there is no way to tell which year each one covers.
     A year is chosen per file, so each lands as ITR_<year>. Same field is offered on
     returns already on file (META_INPUT_KIND marks up_itr as 'year'). Business forms
     only — the salaried forms have no ITR field, and this simply does nothing there.
     ═══════════════════════════════════════════════════════════════════════════ */

  var itrYears = {};   // file index -> year picked for that file

  function renderItrYears() {
    var inp = document.getElementById('up_itr');
    var box = document.getElementById('itr-year-container');
    if (!inp || !box) return;
    var files = inp.files ? Array.prototype.slice.call(inp.files) : [];
    itrYears = {};
    box.innerHTML = '';
    if (!files.length) return;

    var years = itrYearList();
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px;padding:13px;background:#eff6ff;border:2px solid #3b82f6;border-radius:10px';
    wrap.innerHTML = '<div style="font-size:13px;font-weight:700;color:#1e40af;margin-bottom:4px">' +
      '\uD83D\uDCC5 Which year is each return for?</div>' +
      '<p style="margin:0 0 10px;font-size:11.5px;color:#1e3a8a">' +
      'Pick the year for each file so the three returns are told apart.</p>';

    files.forEach(function (f, i) {
      itrYears[i] = '';
      var row = document.createElement('div');
      row.style.cssText = 'padding:10px;background:#fff;border:1.5px solid #bfdbfe;border-radius:8px;margin-bottom:8px';
      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<div style="flex:1;font-size:12.5px;font-weight:700;color:#0c4a6e;overflow:hidden;' +
            'text-overflow:ellipsis">\uD83D\uDCC4 ' + escapeHtml(f.name) + '</div>' +
          selectedFileRemoveBtn('up_itr', i) +
        '</div>' +
        '<select data-itr-year="' + i + '" style="width:100%;padding:8px 11px;border:2px solid #38bdf8;' +
          'border-radius:8px;font-size:13px;font-weight:600;font-family:inherit;background:#fff;color:#0369a1;' +
          'box-sizing:border-box"><option value="">Select year</option>' +
          years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('') +
        '</select>';
      var field = row.querySelector('[data-itr-year]');
      if (field) field.addEventListener('change', function () { itrYears[i] = field.value; });
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  function watchItrField() {
    var inp = document.getElementById('up_itr');
    if (!inp || inp.getAttribute('data-itr-watch')) return;
    inp.setAttribute('data-itr-watch', '1');
    if (!document.getElementById('itr-year-container')) {
      var box = document.createElement('div');
      box.id = 'itr-year-container';
      var anchor = inp.closest('.ub') || inp;
      if (anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    inp.addEventListener('change', renderItrYears);
  }

  document.addEventListener('DOMContentLoaded', function () { watchItrField(); });

  /* ═══════════════════════════════════════════════════════════════════════════
     CIBIL REPORT -> AUTOMATIC DEEP ANALYSIS

     The moment a CIBIL report is attached, it is read and summarised in place:
     score and factors, KYC match against what was typed on the form, active
     exposure and EMI, current overdues, guarantor exposure, historical
     delinquencies, enquiry pattern and stacking signals. The summary is stored in
     the snapshot so it reappears on reopening and is shown under CIBIL on the
     shared view page. cibil-analysis.js does the reading; this only wires it up.
     ═══════════════════════════════════════════════════════════════════════════ */

  function cibilBox() {
    var inp = document.getElementById('up_cibil');
    if (!inp) return null;
    var box = document.getElementById('cibil-analysis-container');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cibil-analysis-container';
      var anchor = inp.closest('.ub') || inp;
      if (anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    return box;
  }

  function cibilNote(msg, tone) {
    var c = tone === 'warn' ? ['#fffbeb', '#fbbf24', '#92400e'] : ['#eff6ff', '#93c5fd', '#1e3a8a'];
    return '<div style="margin-top:10px;padding:11px 13px;background:' + c[0] + ';border:1.5px solid ' +
      c[1] + ';border-radius:10px;font-size:12.5px;color:' + c[2] + '">' + msg + '</div>';
  }

  // What the agent typed, so the report can be checked against it.
  function applicantForKyc() {
    function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    return { name: v('f_name'), dob: v('f_dob') ? isoToDmy(v('f_dob')) : '', gender: v('f_gender'), pan: v('f_pan_no') };
  }
  function isoToDmy(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : iso;
  }

  function runCibilAnalysis() {
    var inp = document.getElementById('up_cibil');
    var box = cibilBox();
    if (!inp || !box) return;
    var file = inp.files && inp.files[0];
    if (!file) { box.innerHTML = ''; window.__cibilAnalysis = null; return; }
    if (typeof window.CibilAnalysis === 'undefined') {
      box.innerHTML = cibilNote('Could not load the CIBIL reader, so no summary was produced. The report itself is still attached and will be saved.', 'warn');
      return;
    }

    box.innerHTML = cibilNote('\u23F3 Reading the CIBIL report\u2026');
    window.CibilAnalysis.extractText(file).then(function (text) {
      var analysis = window.CibilAnalysis.analyse(text, applicantForKyc());
      if (analysis.scores.score == null && analysis.exposure.totalAccounts === 0) {
        box.innerHTML = cibilNote('This file does not look like a TransUnion CIBIL CIR, so no summary was produced. The document is still attached and will be saved.', 'warn');
        window.__cibilAnalysis = null;
        return;
      }
      window.__cibilAnalysis = analysis;
      box.innerHTML = window.CibilAnalysis.renderHtml(analysis);
    }).catch(function (err) {
      window.__cibilAnalysis = null;
      var why = (err && err.message) === 'IMAGE'
        ? 'This is a photo or scan, which has no text to read. Upload the CIBIL report as a PDF (or the saved HTML) and the summary will be generated automatically.'
        : (err && err.message) === 'NO_PDFJS'
        ? 'The PDF reader did not load on this page, so no summary was produced.'
        : 'Could not read this report automatically, so no summary was produced. The document is still attached and will be saved.';
      box.innerHTML = cibilNote(why, 'warn');
    });
  }
  window.__runCibilAnalysis = runCibilAnalysis;

  function watchCibilField() {
    var inp = document.getElementById('up_cibil');
    if (!inp || inp.getAttribute('data-cibil-watch')) return;
    inp.setAttribute('data-cibil-watch', '1');
    inp.addEventListener('change', runCibilAnalysis);
  }

  document.addEventListener('DOMContentLoaded', function () { watchCibilField(); });

  // Writes the ITR files under their years. Replaces the plain addFiles call the
  // business forms used to make for up_itr.
  window.__addItrDocsToZip = async function (zip, unlockPdf, password) {
    var inp = document.getElementById('up_itr');
    if (!zip || !inp || !inp.files || !inp.files.length) return 0;
    var folder = (typeof zip.folder === 'function') ? zip.folder('Documents') : zip;
    var used = {};
    var written = 0;

    for (var i = 0; i < inp.files.length; i++) {
      var f = inp.files[i];
      var dot = f.name.lastIndexOf('.');
      var ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '';
      var year = safeFileStem(itrYears[i] || '');
      var stem = year ? 'ITR_' + year : 'ITR_3Years';
      used[stem] = (used[stem] || 0) + 1;
      if (used[stem] > 1) stem += '_' + used[stem];
      else if (!year && inp.files.length > 1) stem += '_' + (i + 1);

      var out = f;
      if (password && ext === '.pdf' && typeof unlockPdf === 'function') {
        try { out = await unlockPdf(f, password); } catch (e) { out = f; }
      }
      folder.file(stem + ext, out);
      written++;
    }
    return written;
  };

  // Writes the SOA files under their lender names. Replaces the plain addFiles call
  // each form used to make for up_soa.
  window.__addSoaDocsToZip = async function (zip, unlockPdf, password) {
    var inp = document.getElementById('up_soa');
    if (!zip || !inp || !inp.files || !inp.files.length) return 0;
    var folder = (typeof zip.folder === 'function') ? zip.folder('Documents') : zip;
    var used = {};
    var written = 0;

    for (var i = 0; i < inp.files.length; i++) {
      var f = inp.files[i];
      var dot = f.name.lastIndexOf('.');
      var ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '';
      var lender = safeFileStem(soaLenders[i] || '');
      var stem = lender ? 'SOA_' + lender : 'SOA_Statement';
      // Two statements from the same lender still need distinct names.
      used[stem] = (used[stem] || 0) + 1;
      if (used[stem] > 1) stem += '_' + used[stem];
      else if (!lender && inp.files.length > 1) stem += '_' + (i + 1);

      var out = f;
      if (password && ext === '.pdf' && typeof unlockPdf === 'function') {
        try { out = await unlockPdf(f, password); } catch (e) { out = f; }
      }
      folder.file(stem + ext, out);
      written++;
    }
    return written;
  };

  /* ═══════════════════════════════════════════════════════════════════════════
     RENAME A DOCUMENT ALREADY ON FILE
     Available on every existing document — property owner KYC, co-applicant,
     guarantor and the rest — not just the ones that take a period.
     ═══════════════════════════════════════════════════════════════════════════ */

  window.__renameDoc = function (docId, btnEl) {
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    var agentId = p.get('agentId');
    if (!numberId) { alert('Cannot rename: no lead ID in the URL.'); return; }

    var row = btnEl.closest('[data-docrow]') || btnEl.closest('span');
    var link = row ? row.querySelector('a') : null;
    var currentRaw = link ? link.textContent.replace(/^[^\w]*\s*/, '').trim() : '';
    var current = currentRaw.replace(/\.[^.]+$/, '');

    var next = prompt('Rename this document to:', current);
    if (next === null) return;
    next = next.trim();
    if (!next) { alert('The name cannot be empty.'); return; }
    if (/[<>:"/\\|?*]/.test(next)) { alert('Avoid these characters: < > : " / \\ | ? *'); return; }

    // Keep the owner prefix so a party's document stays attributed to them.
    var ownerMatch = currentRaw.match(/^((?:coapplicant|guarantor)[ _]*\d+)[ _]/i);
    var prefix = ownerMatch ? ownerMatch[1].replace(/[ _]+/g, '') + '_' : '';
    if (prefix && next.toLowerCase().indexOf(prefix.toLowerCase()) === 0) prefix = '';

    btnEl.disabled = true;
    btnEl.style.opacity = '0.5';

    fetch('/api/agent/doc-label/' + encodeURIComponent(numberId) + '/' + encodeURIComponent(docId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agentId || '', label: prefix + next })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
        if (d.error) { alert('Could not rename: ' + d.error); return; }
        if (link) link.innerHTML = '\uD83D\uDCC4 ' + escapeHtml(d.filename || next);
      })
      .catch(function () {
        btnEl.disabled = false;
        btnEl.style.opacity = '1';
        alert('Network error while renaming.');
      });
  };

  // Small pencil control appended to an existing-document chip.
  function renameBtnHtml(docId) {
    return '<button type="button" onclick="window.__renameDoc(\'' + escapeHtml(docId) + '\',this)" ' +
      'style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;' +
      'background:transparent;border:none;border-left:1px solid #bbf7d0;color:#2563eb;font-size:12px;' +
      'cursor:pointer;padding:0" title="Rename this document">\u270F\uFE0F</button>';
  }
  window.__renameBtnHtml = renameBtnHtml;
})();
