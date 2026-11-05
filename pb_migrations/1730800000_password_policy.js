/// <reference path="../pb_data/types.d.ts" />
// Password policy: forced first-login change, 12-character minimum, reset emails that
// open BrewCRM's own reset page, and CRM data locked until a temporary password is changed.

const CRM = ["accounts", "contacts", "deals", "touches", "leads"];
const ACTIVE = "@request.auth.id != '' && @request.auth.must_change_password = false";
const AUTH = "@request.auth.id != ''";

const RESET_SUBJECT = "Reset your BrewCRM password";
const RESET_BODY = `<p>Hello,</p>
<p>Someone asked to reset the password for your BrewCRM account. Click the button below to choose a new one.</p>
<p>
  <a class="btn" href="{APP_URL}/#/reset/{TOKEN}" target="_blank" rel="noopener">Choose a new password</a>
</p>
<p><i>If you didn't ask for this, ignore this email. Your password stays the same.</i></p>
<p>Thanks,<br/>BrewCRM</p>`;

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  if (!users.fields.getByName("must_change_password")) {
    users.fields.add(new BoolField({ name: "must_change_password" }));
  }
  const pw = users.fields.getByName("password");
  pw.min = 12;
  users.resetPasswordTemplate.subject = RESET_SUBJECT;
  users.resetPasswordTemplate.body = RESET_BODY;
  app.save(users);

  for (const name of CRM) {
    const c = app.findCollectionByNameOrId(name);
    c.listRule = ACTIVE;
    c.viewRule = ACTIVE;
    c.createRule = ACTIVE;
    c.updateRule = ACTIVE;
    c.deleteRule = ACTIVE;
    app.save(c);
  }
}, (app) => {
  for (const name of CRM) {
    const c = app.findCollectionByNameOrId(name);
    c.listRule = AUTH;
    c.viewRule = AUTH;
    c.createRule = AUTH;
    c.updateRule = AUTH;
    c.deleteRule = AUTH;
    app.save(c);
  }
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("must_change_password");
  users.fields.getByName("password").min = 8;
  app.save(users);
});
