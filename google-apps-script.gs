/**
 * Bill Tracker → Google Sheets bridge.
 *
 * Paste this into Extensions ▸ Apps Script inside the Google Sheet you want the
 * bills to appear in, then deploy it as a Web App (see README). It receives
 * each bill from the Bill Tracker server and writes/updates a row, showing the
 * attached photos inline in the sheet (the photos are hosted on Cloudinary).
 *
 * One-time setup in the Apps Script editor:
 *   Project Settings ▸ Script properties ▸ add property:
 *       SECRET = (the same value you put in the app's .env SHEETS_WEBHOOK_SECRET)
 */

var SHEET_NAME = 'Bills';
var HEADERS = ['ID', 'Date', 'Bill Type', 'Vendor', 'Amount', 'Status', 'Note', 'Created', 'Proof', 'Photos →'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    var want = PropertiesService.getScriptProperties().getProperty('SECRET') || '';
    if (want && body.secret !== want) {
      return json({ ok: false, error: 'bad secret' });
    }

    if (body.action === 'delete') {
      deleteRow(body.id);
      return json({ ok: true });
    }
    upsert(body.bill);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRow(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function deleteRow(id) {
  var sh = getSheet();
  var row = findRow(sh, id);
  if (row) sh.deleteRow(row);
}

function upsert(bill) {
  var sh = getSheet();
  var existing = findRow(sh, bill.id);

  var dataRow = [
    bill.id,
    bill.bill_date || '',
    (bill.tags && bill.tags.length ? bill.tags.join(', ') : (bill.bill_type || '')),
    bill.vendor || '',
    bill.amount || '',
    bill.status || '',
    bill.note || '',
    bill.created_at || '',
  ];

  var row = existing || (sh.getLastRow() + 1);
  if (existing) {
    // Update text columns only; keep the existing photo cells.
    sh.getRange(row, 1, 1, dataRow.length).setValues([dataRow]);
    return;
  }

  sh.getRange(row, 1, 1, dataRow.length).setValues([dataRow]);

  // Photos are public Cloudinary URLs — show them inline and link to the first.
  var photos = bill.photos || [];
  if (!photos.length) return;

  sh.getRange(row, 9).setFormula('=HYPERLINK("' + photos[0].url + '","View (' + photos.length + ')")');
  var col = 10; // column J onward
  for (var i = 0; i < photos.length && i < 8; i++) {
    sh.getRange(row, col).setFormula('=IMAGE("' + photos[i].url + '")');
    col++;
  }
  sh.setRowHeight(row, 90);
}
