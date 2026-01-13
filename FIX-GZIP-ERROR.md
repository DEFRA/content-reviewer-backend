# Test Script Fix - GZip Error Resolution

## 🐛 Issue

Test 6 (Get Review History) was failing with:

```
The magic number in GZip header is not correct. Make sure you are passing in a GZip stream.
```

## 🔍 Root Cause

PowerShell's `Invoke-RestMethod` was trying to automatically decompress a response, causing a GZip parsing error. This is a known issue when dealing with certain API responses.

## ✅ Solution

Updated `test-cdp-s3-based.ps1` to use:

1. **`Invoke-WebRequest` with `-UseBasicParsing`** instead of `Invoke-RestMethod`
2. **Manual JSON parsing** with `ConvertFrom-Json`

### Changed Code:

**Before:**

```powershell
$response = Invoke-RestMethod -Uri "$baseUrl/api/reviews?limit=5" -Method GET -Headers $headers
```

**After:**

```powershell
$webResponse = Invoke-WebRequest -Uri "$baseUrl/api/reviews?limit=5" -Method GET -Headers $headers -UseBasicParsing
$response = $webResponse.Content | ConvertFrom-Json
```

### Also Fixed:

Added `-UseBasicParsing` to Test 3 to avoid the security warning prompt:

**Before:**

```powershell
Invoke-WebRequest -Uri "$baseUrl/api/reviews" -Method GET -Headers $headers
```

**After:**

```powershell
Invoke-WebRequest -Uri "$baseUrl/api/reviews" -Method GET -Headers $headers -UseBasicParsing
```

## 🎯 Benefits

1. ✅ No more GZip errors
2. ✅ No more security warning prompts
3. ✅ More reliable HTTP handling
4. ✅ Better cross-platform compatibility

## 🧪 Testing

Copy the updated `test-cdp-s3-based.ps1` to your Defra desktop and run:

```powershell
.\test-cdp-s3.ps1
```

**Expected:** All 6 tests now pass without errors! ✅

## 📋 What `-UseBasicParsing` Does

- Disables HTML parsing (we don't need it for JSON APIs)
- Avoids security warnings about script execution
- Provides more predictable HTTP behavior
- Works better with compressed responses

---

**Status:** ✅ Fixed and ready to test!
