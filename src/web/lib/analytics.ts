export interface UserStats {
  id: string;
  uplink: number;
  downlink: number;
  disabled?: boolean;
}

export interface PeriodData {
  vps_id: string;
  period: string;
  users: UserStats[];
  daily?: {
    date: string;
    users: UserStats[];
    quality: string;
    archived: boolean;
  };
}

export function aggregate(data: PeriodData[]) {
  const users = new Map<string, { uplink: number; downlink: number }>();
  let totalUp = 0;
  let totalDown = 0;
  
  for (const row of data) {
    const list = row.daily ? row.daily.users : row.users;
    for (const u of list) {
      const existing = users.get(u.id) || { uplink: 0, downlink: 0 };
      existing.uplink += u.uplink;
      existing.downlink += u.downlink;
      users.set(u.id, existing);
      totalUp += u.uplink;
      totalDown += u.downlink;
    }
  }
  
  return { users, totalUp, totalDown };
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i >= sizes.length) return (bytes / Math.pow(k, sizes.length - 1)).toFixed(2) + ' ' + sizes[sizes.length - 1];
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function bytesToGiB(bytes: number, decimals = 2): number {
  if (!bytes || bytes <= 0) return 0;
  return parseFloat((bytes / 1073741824).toFixed(decimals));
}
