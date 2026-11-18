import type { Metadata } from 'next';
import ContactForm from '@/components/contact/ContactForm';

export const metadata: Metadata = {
  title: 'Contact Pakdam — support and business enquiries',
  description: 'Contact Pakdam for support or business enquiries. English only, 18+, private invite-only.',
  alternates: { canonical: '/contact' },
};

export default function ContactPage() {
  return <ContactForm />;
}
