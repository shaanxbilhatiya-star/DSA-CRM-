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

  // On load: if this form is opened for an existing saved lead, prefill it and
  // switch to "Update" mode.
  window.addEventListener('load', function () {
    var p = new URLSearchParams(location.search);
    var numberId = p.get('numberId');
    if (!numberId) return;
    // Let each form finish its own init first (salary toggles, obligation rows…).
    setTimeout(function () {
      fetch('/api/lead-form/' + encodeURIComponent(numberId))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.exists) return;

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


          markUpdateMode(d);
        })
        .catch(function () {});
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
    var wrap = document.querySelector('.wrap') || document.body;
    var banner = document.createElement('div');
    banner.id = 'editModeBanner';
    banner.style.cssText = 'background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #6ee7b7;border-radius:12px;padding:14px 18px;margin-bottom:16px;color:#065f46;font-size:13.5px;line-height:1.6';
    var docList = docs.length
      ? '<div style="margin-top:6px;font-size:12.5px;color:#047857">On file: ' +
          docs.map(function (x) { return escapeHtml(x.label || x.filename); }).join(', ') +
        '</div>'
      : '';
    banner.innerHTML =
      '<strong>&#128260; Editing an existing submission.</strong> ' +
      'Your saved details have been loaded below. Change anything you like and press ' +
      '<strong>Update File</strong> to save. Re-uploading documents is optional \u2014 ' +
      'leave a document empty to keep the one already on file.' + docList;
    wrap.insertBefore(banner, wrap.firstChild);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
