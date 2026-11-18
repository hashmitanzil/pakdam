import type { Metadata } from 'next';
import ProfileClient from '@/components/profile/ProfileClient';

export const metadata: Metadata = {
  title: 'Your profile — Pakdam guest profile',
  description: 'Your Pakdam profile: display name, opt-in monthly leaderboard points computed from finished matches on this device, friends and people you played with in the last 7 days. Free account, no payment.',
  alternates: { canonical: '/profile' },
};

export default function ProfilePage() {
  return <ProfileClient />;
}
