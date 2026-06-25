/**
 * Bill Tracker → Google Sheets bridge.
 *
 * Paste this into Extensions ▸ Apps Script inside the Google Sheet you want the
 * bills to appear in, then deploy it as a Web App (see README). It receives
 * each bill from the Bill Tracker server and writes/updates a row, saving the
 * attached photos to Google Drive and showing them inline in the sheet.
 *
 * One-time setup in the Apps Script editor:
 *   Project Settings ▸ Script properties ▸ add property:
 *       SECRET = (the same value you put in the app's .env SHEETS_WEBHOOK_SECRET)
 */

var SHEET_NAME = 'Bills';
var PHOTO_FOLDER = 'Bill Tracker Photos';
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

function getPhotoFolder() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
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

  if (existing) {
    // Update the text columns only; keep the already-uploaded photo cells.
    sh.getRange(existing, 1, 1, dataRow.length).setValues([dataRow]);
    return;
  }

  // New row: append data, then upload + embed photos.
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, dataRow.length).setValues([dataRow]);

  var photos = bill.photos || [];
  if (!photos.length) return;

  var folder = getPhotoFolder();
  var firstUrl = '';
  var col = 10; // start photos at column J (after "Proof")
  for (var i = 0; i < photos.length && i < 8; i++) {
    var p = photos[i];
    var blob = Utilities.newBlob(Utilities.base64Decode(p.data), p.mime, p.name || ('photo-' + bill.id));
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var id = file.getId();
    if (!firstUrl) firstUrl = 'https://drive.google.com/file/d/' + id + '/view';

    // Inline thumbnail. If it ever shows blank, the Proof link still opens it.
    sh.getRange(row, col).setFormula('=IMAGE("https://lh3.googleusercontent.com/d/' + id + '=w160")');
    col++;
  }
  sh.setRowHeight(row, 90);

  if (firstUrl) {
    sh.getRange(row, 9).setFormula('=HYPERLINK("' + firstUrl + '","View (' + photos.length + ')")');
  }
}
