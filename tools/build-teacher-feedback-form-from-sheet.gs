/**
 * Together For Health — teacher feedback form builder (run from INSIDE a spreadsheet).
 *
 * USE THIS VERSION if the standalone script at script.google.com gave you
 *   "Access blocked: Authorization Error — The OAuth client was not found (401 invalid_client)".
 * A script that lives inside a spreadsheet authorises through that spreadsheet, which
 * avoids the standalone-project OAuth client that error is complaining about.
 *
 * HOW TO RUN IT
 *   1. Go to sheets.new  (that makes a blank spreadsheet)
 *   2. Rename it something like "Teacher feedback responses" (top-left)
 *   3. Extensions -> Apps Script
 *   4. Delete what is in the editor, paste this whole file in, Ctrl+S
 *   5. Press Run. Approve the permissions when asked.
 *   6. The form link appears in the Execution log at the bottom.
 *   7. Back in the SPREADSHEET: Share -> Anyone with the link -> Viewer, then copy its
 *      link and paste that into your site: Feedback -> Teacher form -> Connect & sync.
 *
 * This version deliberately does NOT ask for Drive permission — that is why step 7 is
 * done by hand. Fewer permissions to approve means fewer things that can be refused.
 *
 * IMPORTANT: the question TITLES below are what the website matches on to work out which
 * answer is which. Reword the helper text freely — it never reaches the spreadsheet — but
 * if you change a title, keep its key words: "which presentation", "class", "how many",
 * "overall", "have us back", "worked"/"well", "better", "name and role".
 */

function buildTeacherFeedbackForm() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) {
    throw new Error('Run this from inside a spreadsheet: Extensions -> Apps Script.');
  }

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

  // setRequireLogin is Workspace-only and throws on a plain gmail.com account, which would
  // abandon the run and leave a half-built form. Nothing to turn off on a personal account.
  try {
    form.setRequireLogin(false);
  } catch (e) {
    Logger.log('Note: "restrict to my organisation" is Workspace-only and does not apply ' +
               'to this account. Nothing to turn off. Carrying on.');
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

  // ── Send responses to THIS spreadsheet ────────────────────────────────────────────
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Linking adds a "Form Responses 1" tab. The website reads the FIRST tab, so if the
  // blank starter sheet is still sitting in front of it the site would read an empty
  // sheet and report no responses. Move the responses tab to the front instead of
  // deleting anything, so nothing you may have typed is lost.
  SpreadsheetApp.flush();
  var sheets = ss.getSheets();
  var responses = null;
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().indexOf('Form Responses') === 0) { responses = sheets[i]; }
  }
  if (responses) {
    ss.setActiveSheet(responses);
    ss.moveActiveSheet(1);
  }

  var out = [
    '',
    '=========================================================',
    '  DONE.',
    '=========================================================',
    '',
    '  THE FORM  (send to teachers, or turn into a QR code)',
    '     ' + form.getPublishedUrl(),
    '',
    '  Edit the form later:',
    '     ' + form.getEditUrl(),
    '',
    '  NOW DO THIS BIT BY HAND (one click):',
    '   1. Go back to this spreadsheet',
    '   2. Share -> General access -> Anyone with the link -> Viewer',
    '   3. Copy link',
    '   4. On your site: Feedback -> Teacher form -> paste -> Connect & sync',
    '',
    '  This spreadsheet:',
    '     ' + ss.getUrl(),
    '========================================================='
  ].join('\n');

  Logger.log(out);
  return out;
}
