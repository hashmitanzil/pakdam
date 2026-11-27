'use client';

/**
 * Rooms — /admin/rooms.
 *
 * Live + recent rooms: code, phase, players, started, zone size.
 * Tapping a room opens its detail page.
 */
import Link from 'next/link';
import { listAdminRooms } from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AdminCard, AdminEmpty, AdminError, AdminLoading } from '../../../components/admin/AdminUi';

export default function AdminRoomsPage() {
  const { data, loading, error, retry } = useAdminData(() => listAdminRooms());

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Rooms</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Live and recent games. Tap a room to see its players and end it.</p>
      </div>

      {loading ? <AdminLoading what="rooms" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {data && data.length === 0 ? <AdminEmpty message="No rooms yet — nothing has been played." /> : null}

      {data
        ? data.map((room) => (
            <Link key={room.id} href={`/admin/rooms/${room.id}`}>
              <AdminCard>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[17px] font-bold tracking-wide text-white">{room.code}</p>
                    <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                      {room.phase} · {room.players} players
                      {room.startedAt ? ` · started ${new Date(room.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ' · not started'}
                    </p>
                    <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                      Zone: {room.zoneRadiusMetres !== null ? `${room.zoneRadiusMetres} m` : '—'}
                    </p>
                  </div>
                  <span aria-hidden className="text-[18px] text-[#EF4444]">
                    →
                  </span>
                </div>
              </AdminCard>
            </Link>
          ))
        : null}
    </>
  );
}
