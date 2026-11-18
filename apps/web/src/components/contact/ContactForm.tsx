'use client';
import { useState } from 'react';
import { queueNonCompetitive } from '@/lib/offline-queue';

/** Contact messages are stored on this device only (demo). No support email
 *  or phone number exists yet — no invented contact details are published.
 *  localStorage key: pakdam.contact.v1 */
interface ContactMessage { ref: string; name: string; email: string; topic: string; message: string; at: string }

export default function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [topic, setTopic] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [ref, setRef] = useState('');
  const [fail, setFail] = useState('');

  function submit() {
    const errs: string[] = [];
    if (name.trim().length < 2 || name.trim().length > 50) errs.push('Enter your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.push('Enter a valid email address so we can reply');
    if (!topic) errs.push('Choose a topic');
    if (message.trim().length < 10) errs.push('Write your message — at least 10 characters');
    if (message.trim().length > 2000) errs.push('Message is too long — 2000 characters or fewer');
    setErrors(errs);
    if (errs.length) return;
    setSending(true);
    setFail('');
    try {
      const reference = 'CT-' + String(Math.floor(1000 + Math.random() * 9000));
      const items: ContactMessage[] = JSON.parse(localStorage.getItem('pakdam.contact.v1') ?? '[]') as ContactMessage[];
      items.push({ ref: reference, name: name.trim(), email: email.trim(), topic, message: message.trim(), at: new Date().toISOString() });
      localStorage.setItem('pakdam.contact.v1', JSON.stringify(items));
      queueNonCompetitive('contact-message', { ref: reference, topic });
      setRef(reference);
      setName(''); setEmail(''); setTopic(''); setMessage('');
    } catch {
      setFail('Could not send — try again. Your draft is kept above.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h1>Contact</h1>
      <p>Questions, safety concerns, bug reports, or business enquiries. There is no published support email or phone number yet — use this form, the <a href="/help">Help page</a>, or the <a href="/grievance">grievance route</a> for formal complaints.</p>
      <p className="small">We use your email only to reply to this message. We do not share it. See our <a href="/legal">Privacy Policy</a>. This form collects no location.</p>

      {ref ? (
        <div className="banner" role="status">
          <strong>Thanks — we&apos;ve received your message. Reference {ref}.</strong>
          <p>Note: your message is stored on this device only — no support inbox exists yet, so nothing has been sent to a real team. A reply time is not promised until support staffing is confirmed.</p>
        </div>
      ) : null}
      {fail ? <p role="alert">{fail}</p> : null}
      {errors.length > 0 ? (
        <div role="alert"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      ) : null}

      <label className="label" htmlFor="contact-name">Name</label>
      <input id="contact-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="contact-name-hint" />
      <p id="contact-name-hint" className="small">Required, 2–50 characters.</p>

      <label className="label" htmlFor="contact-email">Email</label>
      <input id="contact-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

      <label className="label" htmlFor="contact-topic">Topic</label>
      <select id="contact-topic" className="input" value={topic} onChange={(e) => setTopic(e.target.value)}>
        <option value="">Choose a topic</option>
        <option value="General question">General question</option>
        <option value="Safety concern">Safety concern</option>
        <option value="Bug report">Bug report</option>
        <option value="Press">Press</option>
        <option value="Other">Other</option>
      </select>

      <label className="label" htmlFor="contact-message">Message</label>
      <textarea id="contact-message" className="input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} />
      <p className="small">{message.length}/2000 characters.</p>

      <p><button className="btn" onClick={submit} disabled={sending}>{sending ? 'Sending…' : 'Send message'}</button></p>
      <p className="small">For a formal complaint about content, conduct, or a decision — for example, you were removed unfairly — use the <a href="/grievance">grievance route</a> instead. That is a different process from a bug report.</p>
    </div>
  );
}
