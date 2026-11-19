import { redirect } from 'next/navigation';

// Routing decision: there is no separate setup form — setup lives in the
// lobby-is-setup screen, so /create goes straight to mode select.
export default function CreatePage() {
  redirect('/create/mode');
}
