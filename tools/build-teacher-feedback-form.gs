/**
 * Together For Health — builds the teacher feedback form in one run.
 *
 * WHAT IT DOES
 *   1. Creates the Google Form with all 8 questions, their helper text and their options.
 *   2. Applies the three settings that matter (no email collection, no forced sign-in).
 *   3. Creates the response spreadsheet, links the form to it, and removes the blank
 *      default tab so the responses are the FIRST tab — which is the one the website reads.
 *   4. Shares that spreadsheet as "anyone with the link can view", which is what lets the
 *      website read it with no password.
 *   5. Prints the form link and the spreadsheet link for you.
 *
 * HOW TO RUN IT
 *   - Go to script.google.com -> New project
 *   - Delete whatever is in the editor, paste this whole file in, press Ctrl+S
 *   - Press Run. Google will ask you to authorise your own script: pick your account,
 *     and if it warns the app is unverified, that is because YOU just wrote it — open
 *     "Advanced" and continue. It only ever touches the form and sheet it creates.
 *   - When it finishes, the two links appear in the Execution log at the bottom.
 *
 * IMPORTANT: the question TITLES below are what the website matches on to work out which
 * answer is which. Reword the helper text freely — it never reaches the spreadsheet — but
 * if you change a title, keep its key words: "which presentation", "class", "how many",
 * "overall", "have us back", "worked"/"well", "better", "name and role".
 */

function buildTeacherFeedbackForm() {
  var TITLE = 'Together For Health — Teacher Feedback';

  var form = FormApp.create(TITLE);
  form.setTitle(TITLE);
  form.setDescription(
    'Together For Health just presented in your class — thank you for the period. This ' +
    'takes about a minute, and it is how we decide what to change before the next class.\n\n' +
    'Most questions are one tap. Please don’t include any student’s name in your answers.\n\n' +
    'Where your answers go: they land in a spreadsheet shared view-only with anyone holding ' +
    'its link, and they appear on our club website. Please treat anything you type here as ' +
    'public. We never ask for your email. The last question asks for your name, and is ' +
    'optional — read the note on it before you fill it in.'
  );

  // ── Settings. These are the ones that would otherwise quietly record who answered. ──
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false); // this one forces a Google sign-in
  form.setAllowResponseEdits(true);       // safe: an edit keeps its timestamp, so the
                                          // website updates that card in place
  form.setProgressBar(false);
  form.setShowLinkToRespondAgain(false);

  // setRequireLogin only exists on Google Workspace accounts. On a plain gmail.com account
  // it throws, which would abandon the script halfway and leave a half-built form behind.
  // There is nothing to turn off on a personal account anyway — the restriction it controls
  // is a Workspace-only feature.
  try {
    form.setRequireLogin(false);
  } catch (e) {
    Logger.log('Note: "restrict to my organisation" is a Workspace-only setting and does ' +
               'not apply to this account. Nothing to turn off. Carrying on.');
  }

  // ── Q1 ──
  form.addMultipleChoiceItem()
    .setTitle('Which presentation did you see?')
    .setHelpText('Pick the closest one. If we covered something else, use Other.')
    .setChoiceValues(['Mental Health', 'Depression', 'Vaping', 'Nutrition',
                      'Physical Activity', 'Sleep', 'Stress', 'Bullying',
                      'CPR & First Aid', 'Body Image'])
    .showOtherOption(true)
    .setRequired(true);

  // ── Q2 ──
  form.addTextItem()
    .setTitle('Which class was this for?')
    .setHelpText('e.g. “Grade 9 Health, period 3”. If we came to you from another ' +
                 'school, add it — e.g. “Grade 11 Bio, Westview SS”.')
    .setRequired(true);

  // ── Q3. Number validation so a teacher cannot submit a range like "25-30". ──
  var numberOnly = FormApp.createTextValidation()
    .setHelpText('Just the digits, please — e.g. 28')
    .requireNumber()
    .build();
  form.addTextItem()
    .setTitle('Roughly how many students were in the room?')
    .setHelpText('An estimate is fine — a number, not a range.')
    .setValidation(numberOnly)
    .setRequired(true);

  // ── Q4. Must be 1-5. The website reads a single digit 1-5 from this column. ──
  form.addScaleItem()
    .setTitle('Overall, how did it go?')
    .setBounds(1, 5)
    .setLabels('Not a fit for my class', 'Please come back')
    .setRequired(true);

  // ── Q5. The only question that measures what a teacher would DO, not how they felt. ──
  form.addMultipleChoiceItem()
    .setTitle('Would you have us back for this unit next year?')
    .setChoiceValues(['Yes — same presentation, same spot in the unit',
                      'Yes — but I’d want a different topic',
                      'Yes — but shorter, or a different format',
                      'Probably not'])
    .setRequired(true);

  // ── Q6. The one required long answer. It becomes the pull-quote on the website. ──
  form.addParagraphTextItem()
    .setTitle('What worked well? (A sentence we could quote would mean a lot.)')
    .setHelpText('One or two sentences is plenty. The most useful thing you can tell us is ' +
                 'something specific you saw or heard — a question a student asked, a ' +
                 'moment the room went quiet, something a student said on the way out. ' +
                 '“Good job” is kind, but we can’t learn from it.')
    .setRequired(true);

  // ── Q7 ──
  form.addParagraphTextItem()
    .setTitle('What could we do better next time?')
    .setHelpText('Blunt is welcome — we would rather hear it than repeat it.')
    .setRequired(false);

  // ── Q8. The title IS the consent, and filling it in is the act of giving it. ──
  form.addTextItem()
    .setTitle('Your name and role, if you’re happy for us to quote you (optional)')
    .setHelpText('Optional. If you fill this in, we may quote you by name on our club ' +
                 'website, in our year-end report, and in club members’ university and ' +
                 'scholarship applications. Our response sheet is shared view-only with ' +
                 'anyone holding its link, so please treat anything you type in this form ' +
                 'as public. Leave this blank and your answers stay anonymous — they ' +
                 'still count.')
    .setRequired(false);

  // ── Response spreadsheet ──────────────────────────────────────────────────────────
  var ss = SpreadsheetApp.create(TITLE + ' — responses');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Linking adds a "Form Responses 1" tab alongside the blank "Sheet1" that a new
  // spreadsheet always starts with. The website reads the FIRST tab by default, so the
  // blank one has to go or it would read an empty sheet and report no responses.
  SpreadsheetApp.flush();
  var live = SpreadsheetApp.openById(ss.getId());
  var blank = live.getSheetByName('Sheet1');
  if (blank && live.getSheets().length > 1) {
    live.deleteSheet(blank);
  }

  // ── Sharing. This is what lets the website read it with no password at all. ───────
  DriveApp.getFileById(ss.getId())
    .setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var sheetUrl = live.getUrl();
  var out = [
    '',
    '=========================================================',
    '  DONE. Two links:',
    '=========================================================',
    '',
    '  1. THE FORM  (send this to teachers, or make it a QR code)',
    '     ' + form.getPublishedUrl(),
    '',
    '  2. THE RESPONSE SHEET  (paste this into the website)',
    '     ' + sheetUrl,
    '',
    '  Next: on your site go to Feedback → Teacher form, paste',
    '  link 2 into the top box, and press "Connect & sync".',
    '',
    '  Edit the form later here:',
    '     ' + form.getEditUrl(),
    '========================================================='
  ].join('\n');

  Logger.log(out);
  return out;
}
