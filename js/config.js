// Deployment settings. Everything here ships to every phone in plain text, so nothing secret goes here.
export const CONFIG = {
  // How finished records leave the phone:
  //   "email" - Finish opens a pre-addressed email with the data in it; crews tap Send. Photos go
  //             separately via "Send photos". Apps Script reads the inbox. Works with no Google login.
  //   "post"  - no-cors POST to the Apps Script web app (needs a web app open to "Anyone")
  //   "form"  - no-cors POST into a Google Form (needs forms open to outside responses; no photos)
  transport: "email",

  // "post" route: the Apps Script web app URL (ends in /exec).
  appsScriptUrl: "",

  // "form" route: https://docs.google.com/forms/d/e/<id>/formResponse and the long-answer field id.
  formResponseUrl: "",
  formEntryId: "entry.0000000000",

  // "email" route: the inbox the Apps Script reads (the script must run under this account).
  inboxEmail: "trent.lewis@ervincable.com",

  // Shared value the receiving script checks to drop junk submissions. Not a secret.
  token: "Splice-7kq2",

  appVersion: "0.2.0",
};
