# Document Metadata Upload Feature - Status

## Date: September 11, 2026

---

## Feature Overview

Added metadata prompts when uploading salary slips and bank statements so files are properly named instead of random numbers.

### Salary Slips
- **Before:** Salary_Slip_1.pdf, Salary_Slip_2.pdf
- **After:** Salary_Slip_January_2026.pdf, Salary_Slip_February_2026.pdf

### Bank Statements
- **Before:** Bank_Statement_1.pdf, Bank_Statement_2.pdf
- **After:** Bank_Statement_2026-03-01_to_2026-08-31.pdf

---

## Implementation Status

### ✅ Completed: PL_Salaried (Commit: 37519d9)

**Changes Made:**
1. Modified salary slip upload to use `handleSalarySlipUpload()`
2. Modified bank statement upload to use `handleBankStatementUpload()`
3. Added metadata containers (`sal-metadata-container`, `bank-metadata-container`)
4. Added JavaScript functions:
   - `handleSalarySlipUpload()` - Prompts for month/year per file
   - `handleBankStatementUpload()` - Prompts for from/to dates per file
   - `salarySlipMetadata` object - Stores metadata
   - `bankStatementMetadata` object - Stores metadata
5. Modified `addFiles()` function to use metadata in filenames

**UI Changes:**
- Upload buttons now say "Will ask for month" / "Will ask for date range"
- After upload, metadata form appears below button
- Each file gets its own row with dropdowns/date pickers
- Metadata incorporated into ZIP filenames

---

## ⏳ Remaining Work

###  1. LAP_Salaried Form
**Status:** Pending  
**Files to modify:** `/public/forms/PLJOB-main/LAP_Salaried.html`

**Changes needed:**
- Add `handleSalarySlipUpload()` and `handleBankStatementUpload()` functions (copy from PL_Salaried)
- Replace `onchange="mark(...)"` with `onchange="handleSalarySlipUpload(...)"` for salary slips
- Replace `onchange="mark(...)"` with `onchange="handleBankStatementUpload(...)"` for bank statement
- Add metadata containers below upload buttons
- Modify `addFiles()` function to use metadata
- Add `salarySlipMetadata = {}` and `bankStatementMetadata = {}` variables

### 2. PL_Business Form
**Status:** Pending (NO salary slips, only bank statement)  
**Files to modify:** `/public/forms/PLJOB-main/PL_Business.html`

**Changes needed:**
- Add `handleBankStatementUpload()` function only
- Replace bank statement onchange with `handleBankStatementUpload(...)`
- Add `bank-metadata-container`
- Modify `addFiles()` for bank statements
- Add `bankStatementMetadata = {}` variable

### 3. BL_Business Form
**Status:** Pending (NO salary slips, only bank statement)  
**Files to modify:** `/public/forms/PLJOB-main/BL_Business.html`

**Changes needed:**
- Add `handleBankStatementUpload()` function only
- Replace bank statement onchange with `handleBankStatementUpload(...)`
- Add `bank-metadata-container`
- Modify `addFiles()` for bank statements
- Add `bankStatementMetadata = {}` variable
- **SPECIAL:** Change label text from "Last 12 Months" to "Last **1 Year** (12 Months)" to emphasize requirement

### 4. LAP_Business Form
**Status:** Pending (NO salary slips, only bank statement)  
**Files to modify:** `/public/forms/PLJOB-main/LAP_Business.html`

**Changes needed:**
- Add `handleBankStatementUpload()` function only
- Replace bank statement onchange with `handleBankStatementUpload(...)`
- Add `bank-metadata-container`
- Modify `addFiles()` for bank statements
- Add `bankStatementMetadata = {}` variable

---

## Technical Implementation Details

### JavaScript Functions to Copy

#### For Salary Slips:
```javascript
let salarySlipMetadata = {};
function handleSalarySlipUpload(input, fnId, ubId) {
  if (!input.files || input.files.length === 0) {
    mark(input, fnId, ubId);
    return;
  }
  
  const files = Array.from(input.files);
  const container = document.getElementById('sal-metadata-container');
  container.innerHTML = '';
  container.style.display = 'block';
  
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1];
  
  container.innerHTML = '<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:14px;margin-bottom:10px"><strong style="color:#92400e;font-size:13px">📅 Specify month for each salary slip:</strong></div>';
  
  files.forEach((file, idx) => {
    const id = 'sal-meta-' + idx;
    salarySlipMetadata[idx] = { filename: file.name, month: '', year: '' };
    
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px';
    row.innerHTML = `
      <div style="flex:1;font-size:13px;color:#374151;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file.name}</div>
      <select id="${id}-month" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff" onchange="salarySlipMetadata[${idx}].month=this.value">
        <option value="">Select Month</option>
        ${months.map(m => `<option value="${m}">${m}</option>`).join('')}
      </select>
      <select id="${id}-year" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff" onchange="salarySlipMetadata[${idx}].year=this.value">
        <option value="">Year</option>
        ${years.map(y => `<option value="${y}">${y}</option>`).join('')}
      </select>
    `;
    container.appendChild(row);
  });
  
  mark(input, fnId, ubId);
}
```

#### For Bank Statements:
```javascript
let bankStatementMetadata = {};
function handleBankStatementUpload(input, fnId, ubId) {
  if (!input.files || input.files.length === 0) {
    mark(input, fnId, ubId);
    return;
  }
  
  const files = Array.from(input.files);
  const container = document.getElementById('bank-metadata-container');
  container.innerHTML = '';
  container.style.display = 'block';
  
  container.innerHTML = '<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:14px;margin-bottom:10px"><strong style="color:#92400e;font-size:13px">📅 Specify date range for each bank statement:</strong></div>';
  
  files.forEach((file, idx) => {
    const id = 'bank-meta-' + idx;
    bankStatementMetadata[idx] = { filename: file.name, fromDate: '', toDate: '' };
    
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;flex-wrap:wrap';
    row.innerHTML = `
      <div style="flex:1;min-width:150px;font-size:13px;color:#374151;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file.name}</div>
      <div style="display:flex;align-items:center;gap:8px">
        <label style="font-size:12px;color:#6b7280;font-weight:600">From:</label>
        <input type="date" id="${id}-from" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px" onchange="bankStatementMetadata[${idx}].fromDate=this.value">
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label style="font-size:12px;color:#6b7280;font-weight:600">To:</label>
        <input type="date" id="${id}-to" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px" onchange="bankStatementMetadata[${idx}].toDate=this.value">
      </div>
    `;
    container.appendChild(row);
  });
  
  mark(input, fnId, ubId);
}
```

### Modified addFiles() Function

```javascript
async function addFiles(inputId, prefix, password) {
  const fs = files(inputId);
  // Check if this is salary slips or bank statements to use metadata
  const useSalaryMetadata = (inputId === 'up_salary' && Object.keys(salarySlipMetadata).length > 0);
  const useBankMetadata = (inputId === 'up_bank' && Object.keys(bankStatementMetadata).length > 0);
  
  for (let i=0;i<fs.length;i++) {
    const fileExt = ext(fs[i]);
    let fname = prefix;
    
    // Add metadata to filename if available
    if (useSalaryMetadata && salarySlipMetadata[i]) {
      const meta = salarySlipMetadata[i];
      if (meta.month && meta.year) {
        fname = `${prefix}_${meta.month}_${meta.year}`;
      } else if (meta.month) {
        fname = `${prefix}_${meta.month}`;
      } else {
        fname = prefix + (fs.length>1?'_'+(i+1):'');
      }
    } else if (useBankMetadata && bankStatementMetadata[i]) {
      const meta = bankStatementMetadata[i];
      if (meta.fromDate && meta.toDate) {
        fname = `${prefix}_${meta.fromDate}_to_${meta.toDate}`;
      } else if (meta.fromDate) {
        fname = `${prefix}_from_${meta.fromDate}`;
      } else {
        fname = prefix + (fs.length>1?'_'+(i+1):'');
      }
    } else {
      fname = prefix + (fs.length>1?'_'+(i+1):'');
    }
    
    fname += fileExt;
    
    let finalFile = fs[i];
    if (password && fileExt === '.pdf') {
      finalFile = await unlockPdf(fs[i], password);
    }
    docs.file(fname, finalFile);
  }
}
```

---

## HTML Changes Required

### For Salary Slips:
```html
<!-- OLD -->
<input type="file" ... id="up_salary" onchange="mark(this,'sal-fn','ub-salary')">

<!-- NEW -->
<input type="file" ... id="up_salary" onchange="handleSalarySlipUpload(this,'sal-fn','ub-salary')">
<div id="sal-metadata-container" style="margin-top:10px;display:none"></div>
```

### For Bank Statements:
```html
<!-- OLD -->
<input type="file" ... id="up_bank" onchange="mark(this,'bank-fn','ub-bank')">

<!-- NEW -->
<input type="file" ... id="up_bank" onchange="handleBankStatementUpload(this,'bank-fn','ub-bank')">
<div id="bank-metadata-container" style="margin-top:10px;display:none"></div>
```

---

## BL_Business Special Note

For BL_Business form, the bank statement requirement is **1 year (12 months)**, not 6 months.

**Current label:**
```html
<label>Bank Statement — Last 12 Months <span class="r">*</span></label>
```

**Should emphasize:**
```html
<label>Bank Statement — Last **1 Year** (12 Months) <span class="r">*</span></label>
```

Or in the description list:
```html
<li>Bank Statement — Last 1 Year (12 Months)</li>
```

---

## Testing Checklist

### For Each Form:
- [ ] Upload single salary slip → metadata form appears
- [ ] Select month and year → saves correctly
- [ ] Upload multiple salary slips → each gets own row
- [ ] Upload bank statement → date range form appears
- [ ] Select from/to dates → saves correctly
- [ ] Save form → ZIP contains properly named files
- [ ] Files named: Salary_Slip_March_2026.pdf ✅
- [ ] Files named: Bank_Statement_2026-01-01_to_2026-06-30.pdf ✅
- [ ] Skip metadata → defaults to _1, _2, _3 numbering

### Forms to Test:
- [x] PL_Salaried - Completed
- [ ] LAP_Salaried - Needs implementation
- [ ] PL_Business - Needs implementation (bank only)
- [ ] BL_Business - Needs implementation (bank only) + 1 year emphasis
- [ ] LAP_Business - Needs implementation (bank only)

---

## Benefits

### Before:
❌ Salary_Slip_1.pdf, Salary_Slip_2.pdf, Salary_Slip_3.pdf  
❌ Bank_Statement_1.pdf, Bank_Statement_2.pdf  
❌ No idea which month or date range  
❌ Have to open every file to check  
❌ Confusing for reviewers  

### After:
✅ Salary_Slip_January_2026.pdf  
✅ Salary_Slip_February_2026.pdf  
✅ Bank_Statement_2026-01-01_to_2026-06-30.pdf  
✅ Instant identification of coverage  
✅ Professional organization  
✅ Easy verification for banks  

---

## Next Steps

1. Apply same changes to LAP_Salaried
2. Apply bank statement changes to PL_Business, BL_Business, LAP_Business
3. Update BL_Business label to emphasize "1 Year"
4. Test all 5 forms
5. Commit and push

---

## Status: Partially Complete

**Completed:** 1/5 forms (20%)  
**Remaining:** 4/5 forms (80%)  

The infrastructure is built and working in PL_Salaried. Now just needs to be replicated to the other forms with minor adjustments based on which documents they collect.
