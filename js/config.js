// Deployment settings. Everything here ships to every phone in plain text, so nothing secret goes here.
export const CONFIG = {
  // How finished records leave the phone. Pick whichever route passed the transport test (test.html):
  //   "post"  - no-cors POST to the Apps Script web app (records + photos)
  //   "form"  - no-cors POST into a Google Form's long-answer field (records only, no photos)
  //   "share" - phone share sheet -> Mail to the group inbox; Apps Script reads the mailbox
  transport: "share",

  // "post" route: the Apps Script web app URL (ends in /exec).
  appsScriptUrl: "",

  // "form" route: https://docs.google.com/forms/d/e/<id>/formResponse and the long-answer field id.
  formResponseUrl: "",
  formEntryId: "entry.0000000000",

  // "share" route: mailbox the Apps Script watches.
  inboxEmail: "",

  // Shared value the receiving script checks to drop junk submissions. Not a secret.
  token: "Splice-7kq2",

  appVersion: "0.1.0",
};
