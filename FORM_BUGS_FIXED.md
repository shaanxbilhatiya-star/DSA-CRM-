# DSA CRM Form System - Bug Fixes Applied

## Overview
This document summarizes the comprehensive fix applied to resolve the "upload something get something else, write something save something else" glitch in the DSA CRM form system.

## ✅ SERVER-SIDE FIXES COMPLETED (`server.js`)

### 1. Document Storage & Identity (explodeZipForLead)
**Problem:** Documents with same label overwrote each other; deleted document IDs were reused causing wrong files to be served on share links.

**Fix Applied:**
- Introduced `groupKey` based on filename (extension-less, multi-file suffix stripped)
- Added stable `num.shareDocSeq` counter that never reuses IDs after deletion
- Multi-file uploads (Aadhaar_Card_1, Aadhaar_Card_2) now properly grouped
- Parse failures on merge now return `false` instead of silent success
- Share links now permanently point to correct documents

### 2. Label-to-Field Mapping (reconstructFormDataFromInfoText)
**Problem:** Legacy leads couldn't reopen properly - field mismatches caused data loss.

**Fixes:**
- `'Business type' → 'f_job'` (was f_biz_type, which doesn't exist in PL_Business)
- `'Business Name' → 'f_company'` (unified, was split between f_company and f_biz_name)
- `'Total biz. exp.' → 'f_exp'` (was f_biz_exp, which doesn't exist)
- `'Monthly net income' → 'f_income'` (unified mapping)
- `'Business address' → 'f_office_addr'` (unified)
- `'Residence to Business Distance' → 'f_biz_distance'` (unified)

### 3. Security Vulnerabilities
**Path Traversal (CRITICAL):**
- `/api/admin/agent-photo/:eid` now sanitizes `eid` parameter to prevent `../../` attacks
- Both PUT and GET endpoints protected

**Unauthenticated Document Deletion (CRITICAL):**
- `DELETE /api/agent/doc/:numberId/:docId` now validates `agentId` ownership
- Only the assigned agent can delete documents

### 4. API Consistency
**Status Field Mismatch:**
- `/api/admin/update-interested` now uses `adminStatus` (was `status`)
- Added same validation as `/api/admin/update-lead-status`
- Prevents silent no-op writes

### 5. Error Handling
- Added global multer error middleware (returns JSON instead of HTML 500)
- XLSX upload now cleans up file on parse failure
- ZIP explosion failure properly rejects upload with error message

---

## ⚠️ CLIENT-SIDE FIXES REQUIRED (NOT YET APPLIED)

Due to a tool execution issue, the following changes were designed but **not successfully written to disk**. They need to be manually applied:

### Files That Need Modification:
1. `public/forms/PLJOB-main/lead-shared.js` (core snapshot/prefill/doc-mapping logic)
2. `public/forms/PLJOB-main/PL_Salaried.html`
3. `public/forms/PLJOB-main/PL_Business.html`
4. `public/forms/PLJOB-main/BL_Business.html`
5. `public/forms/PLJOB-main/LAP_Salaried.html`
6. `public/forms/PLJOB-main/LAP_Business.html`

### Required Changes:

#### A. Document Upload Wiring (HIGH PRIORITY)
**LAP_Business** - Add 18 missing `addFiles()` calls:
```javascript
await addFiles(docs, 'up_cheque', 'Cancelled_Cheque');
await addFiles(docs, 'up_owner1_aadhaar', 'Owner_1_Aadhaar');
await addFiles(docs, 'up_owner1_pan', 'Owner_1_PAN');
// ... (full list in investigation report)
```

**LAP_Salaried** - Add 7 missing `addFiles()` calls for owner/KYC documents

**BL_Business:**
- Add missing input markup for `up_shop_video` (file input was never created)
- Restore `addFiles(docs, 'up_shop_video', 'Shop_Video');`
- Add `addFiles(docs, 'up_perm_proof', 'Permanent_Address_Proof');`

**PL_Business:**
- Add `addFiles(docs, 'up_soa_always', 'SOA_Statement_Always');`
- Rename `up_salary` → `up_itr` (line 435 and all references)
- Rename `pw_salary` → `pw_itr` for consistency

#### B. DOC_TO_INPUT Mapping (`lead-shared.js`)
Add exact-match keys for all upload prefixes to prevent fuzzy-matching hijacks:
```javascript
const DOC_TO_INPUT = {
  // Exact prefix matches (priority)
  'cancelled cheque':    'up_cheque',
  'owner 1 aadhaar':     'up_owner1_aadhaar',
  'owner 1 pan':         'up_owner1_pan',
  // ... (100+ entries)
  
  // Fallback fuzzy keys
  'aadhaar': 'up_aadhaar',
  'pan': 'up_pan',
  // ... existing
};
```

#### C. findUploadInput Logic (`lead-shared.js`)
Replace fuzzy-first with exact-first + longest-match:
```javascript
function findUploadInput(docLabel) {
  const norm = normDocLabel(docLabel);
  // 1. Try exact match
  if (DOC_TO_INPUT[norm]) {
    const el = document.getElementById(DOC_TO_INPUT[norm]);
    if (el) return el;
  }
  // 2. Try exact after stripping trailing number
  const normNoNum = norm.replace(/\s+\d+$/, '');
  if (normNoNum !== norm && DOC_TO_INPUT[normNoNum]) {
    const el = document.getElementById(DOC_TO_INPUT[normNoNum]);
    if (el) return el;
  }
  // 3. Fuzzy substring (longest key first)
  const keys = Object.keys(DOC_TO_INPUT).sort((a,b) => b.length - a.length);
  for (const key of keys) {
    if (norm.includes(key) || key.includes(norm)) {
      const el = document.getElementById(DOC_TO_INPUT[key]);
      if (el) return el;
    }
  }
  return null;
}
```

#### D. Snapshot Layer (`lead-shared.js`)
**collectFormSnapshot:**
- Skip `type="password"` inputs (prevent password persistence)
- Capture obligation rows: `{ __obligations: [{type, bank, emi}...] }`

**applyFormSnapshot:**
- Guard against file inputs: `if (el.type === 'file') continue;`
- Restore obligations: call `addOb()` N times, populate fields, recalculate
- Error isolation: wrap each field assignment in try/catch

**prefillFromInfoFields:**
- Check `el.value` before overwriting (respect snapshot values)
- Mark snapshot-populated fields as `used` to prevent fuzzy overwrite

**Form Switch:**
- Fix carry-over: handle `false`/`0` properly, don't skip selects with values
- Wait for switch POST to complete before navigation
- Restore obligations after switch

#### E. FOIR Threshold Consistency
**PL_Salaried** and **LAP_Salaried:**
- Change saved threshold from 65% to 50% to match on-screen verdict
- Update `foirStatus` calculation

**BL_Business:**
- Add `oninput="updateFoir()"` to net income field (currently missing)

---

## Testing Checklist

### Document Round-Trip
- [ ] Upload PL_Business with ITR → reopen → ITR shows in correct box
- [ ] Upload LAP_Business with all property docs → all 46 slots preserved
- [ ] Upload same doc twice (different extensions) → newer replaces older
- [ ] Delete a doc → share link returns 404, ID never reused

### Form Snapshot
- [ ] Fill all fields + obligations → save → reopen → all values restored
- [ ] Password fields NOT in snapshot (check browser dev tools network tab)
- [ ] Switch form PL→LAP → all carried values preserved (including dropdowns, 0, false)

### Legacy Prefill
- [ ] Old PL_Business lead (pre-JSON) → reopen → business type, exp, income all load

### Security
- [ ] `POST /api/admin/agent-photo/..%2F..%2Fevil.jpg` → returns 400 "Invalid employee ID"
- [ ] Agent A tries `DELETE /api/agent/doc/:numBelongingToAgentB/:docId` → returns 403

### Validation
- [ ] Upload corrupt/empty ZIP → returns 400 "ZIP file is corrupt"
- [ ] Upload 200MB ZIP → returns 400 "File too large"

---

## Known Limitations & Future Work

1. **Absolute Paths in state.json:** If `DATA_ROOT` changes, all doc/sheet paths break. Consider storing relative paths.
2. **No concurrent write protection:** Multiple server processes will clobber each other's state. Add PID lock or use a real database.
3. **No auth on share links:** `/share/:token` is public by design, but `/api/admin/*` routes are equally unauthenticated.
4. **Orphaned files on lead deletion:** Deleting a lead doesn't clean up its docZip or shares folder.

---

## Files Modified

### Applied Changes:
- `server.js` (147 insertions, 39 deletions)

### Pending Changes:
- `public/forms/PLJOB-main/lead-shared.js`
- `public/forms/PLJOB-main/*.html` (all 5 product forms)

---

## Commit Message (When Client Changes Applied)

```
fix: resolve form upload/save data mismatches and security issues

Client-side:
- Wire up 26 missing upload slots across LAP/BL/PL forms
- Fix document name→input mapping (exact-match priority, fuzzy fallback)
- Capture and restore obligations in form snapshot
- Exclude passwords from snapshot
- Fix form-switch carry-over dropping select/false/0 values
- Fix prefill overwriting snapshot values

Server-side:
- Use stable doc IDs (shareDocSeq) to prevent reuse after deletion
- Group multi-file uploads by basename to prevent collisions
- Fix label→field mismatches (Business type, net income, etc.)
- Sanitize agent-photo eid param (prevent path traversal)
- Require agentId ownership check for doc deletion
- Unify adminStatus field across update endpoints
- Add multer error middleware for proper JSON responses
- Clean up orphaned XLSX files on parse failure

Closes: form data corruption, upload slot loss, security vulnerabilities
```
