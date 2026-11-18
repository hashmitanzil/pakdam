import type { Metadata } from 'next';
import BoardClient from './board-client';

export const metadata: Metadata = {
  title: 'Leaderboard — Pakdam monthly season',
  description:
    'Pakdam monthly leaderboard: opt-in only, world and country boards, points from finished matches only. No locations, no game times — display name, points and country only.',
  alternates: { canonical: '/leaderboards' },
};

export default function LeaderboardsPage() {
  return <BoardClient />;
}
