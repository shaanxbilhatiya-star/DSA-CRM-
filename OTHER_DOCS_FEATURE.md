# Other Documents Feature - Implementation Guide

## ✅ COMPLETED: PL_Salaried.html

The "Other Documents" feature has been **fully implemented and tested** in `PL_Salaried.html`.

### Features Implemented:

1. **Custom Document Names** - Users can name any document
2. **Dual Confirmation** - Ask for confirmation after file selection
3. **Multiple Files** - Upload multiple files with different names
4. **Edit Existing** - View/download/delete documents already on server
5. **Full Integration** - Works with ZIP generation and form snapshot

---

## 📋 TO-DO: Replicate to Other 4 Forms

The exact same feature needs to be added to:

1. ✅ **PL_Salaried.html** - DONE
2. ⏳ **PL_Business.html** - PENDING
3. ⏳ **BL_Business.html** - PENDING
4. ⏳ **LAP_Salaried.html** - PENDING
5. ⏳ **LAP_Business.html** - PENDING

---

## 🔧 Implementation Steps (for each remaining form):

### Step 1: Add HTML Section

Insert the "Other Documents" section **before the References section**:

```html
<!-- Find this line in each form -->
<!-- ⑨ REFERENCES -->

<!-- Insert the other-docs section RIGHT BEFORE it -->
```

The complete HTML is in `other-docs-snippet.html`.

### Step 2: Add JavaScript Variables

At the top of the `<script>` section, add these variables:

```javascript
let otherDocsCount = 0;
const otherDocsData = [];
```

### Step 3: Add JavaScript Functions

Copy all "Other Documents" functions from PL_Salaried.html:

- `addOtherDocSlot()`
- `validateOtherDocName()`
- `handleOtherDocFileSelect()`
- `confirmOtherDoc()`
- `cancelOtherDocConfirm()`
- `removeOtherDoc()`
- `addOtherDocsToZip()`
- `window.loadExistingOtherDocs()`

### Step 4: Update saveFile() Function

In the `saveFile()` function, **before** `zip.file('Applicant_Info.txt', txt);`, add:

```javascript
setProgress(82,'Adding other documents...'); 
await addOtherDocsToZip(zip);
```

Adjust the progress percentage numbers accordingly.

---

## 📍 Exact Line Numbers (for reference):

### PL_Business.html
- Insert HTML before line 600 (`<!-- ⑨ REFERENCES -->`)
- Add variables after line ~646 (in `<script>`)
- Add functions before `function setSalaryType` or similar
- Update `saveFile()` around line ~1060 (before `zip.file('Applicant_Info.txt'...`)

### BL_Business.html
- Insert HTML before `<!-- ⑨ REFERENCES -->` section
- Similar pattern as above

### LAP_Salaried.html
- Insert HTML before references
- Similar pattern

### LAP_Business.html
- Insert HTML before references
- Similar pattern

---

## 🎯 Testing Checklist (for each form):

After implementing in each form:

- [ ] Click "Add Another Document" button appears
- [ ] Can enter custom document name
- [ ] Name validation works (duplicates rejected)
- [ ] File selection triggers confirmation dialog
- [ ] Can confirm or edit name
- [ ] Multiple documents can be added
- [ ] Documents get included in ZIP with correct names
- [ ] On edit: existing "other" documents load correctly
- [ ] Can delete existing documents
- [ ] Can replace existing documents by uploading with same name

---

## 🚀 Quick Implementation Script

To speed up implementation, you can:

1. Copy the entire "Other Documents" section from `PL_Salaried.html` (lines with `<!-- ⑧.5 OTHER DOCUMENTS -->`)
2. Copy all JavaScript functions related to other docs
3. Paste into each remaining form in the correct locations
4. Test each form individually

---

## 📝 Notes:

- The feature is **fully backward compatible** - forms without other docs work fine
- Server-side already handles "unmatched" documents via `markExistingDocs()`
- The `lead-shared.js` file was updated to call `window.loadExistingOtherDocs()` when available
- All 5 forms use the same JavaScript logic - only HTML insertion point differs

---

## ⚡ Fast-Track: Copy from PL_Salaried

**Fastest approach:**

1. Open `PL_Salaried.html`
2. Copy lines with entire `<div class="sec" id="sec-other-docs">` section
3. Copy all JavaScript functions between `let otherDocsCount = 0;` and `function setSalaryType()`
4. Paste into each remaining form
5. Update the `saveFile()` function in each
6. Test

**Estimated time per form: 5-10 minutes**

---

**Current Status:** 1 of 5 forms complete (20%)
**Commit:** `41bd2b9` - "feat(forms): add Other Documents feature to PL_Salaried"
