import { route, html, page, act, forms, api, toast, chip, renderRoute } from './core.js';
route('/contacts', {}, async () => {
  const { contacts } = await api('GET', '/me/trusted-contacts');
  return page('Safety contacts', html`<p class="sub">If you miss a check-out after an in-person meeting, we message these people with your meeting details. They must agree first.</p>
    ${contacts.map((c) => html`<div class="card"><div class="row between"><div><b>${c.name}</b><div class="muted small">${c.phone}</div></div>${chip(c.consented ? 'Agreed' : 'Waiting for them to reply YES', c.consented ? 'grn' : 'gold')}</div></div>`)}
    ${contacts.length < 3 ? html`<form data-form="contact"><label>Name</label><input name="name" required><label>Mobile number</label><input name="phone" type="tel" required placeholder="082 123 4567"><button class="btn full" type="submit">Add contact</button></form>` : html`<div class="note">You can name up to 3 contacts.</div>`}
    <p class="note">We only share your location if you press SOS during a live meeting, and only with contacts who agreed.</p>`);
});
forms.contact = async (_f, d) => { await api('POST', '/me/trusted-contacts', d); toast('We texted them to ask for their agreement'); renderRoute(); };
