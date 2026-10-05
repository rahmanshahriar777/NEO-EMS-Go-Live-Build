import React from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: {
    value: string;
    isPositive: boolean;
  };
  color?: 'primary' | 'emerald' | 'cyan' | 'amber' | 'rose';
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  color = 'primary',
}) => {
  const colorMap = {
    primary: 'from-primary-600/20 to-primary-500/10 text-primary-400 border-primary-500/30',
    emerald: 'from-emerald-600/20 to-emerald-500/10 text-emerald-400 border-emerald-500/30',
    cyan: 'from-cyan-600/20 to-cyan-500/10 text-cyan-400 border-cyan-500/30',
    amber: 'from-amber-600/20 to-amber-500/10 text-amber-400 border-amber-500/30',
    rose: 'from-rose-600/20 to-rose-500/10 text-rose-400 border-rose-500/30',
  };

  return (
    <div className="glass-card p-5 rounded-2xl relative overflow-hidden group">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{title}</p>
          <h3 className="text-2xl font-bold text-slate-100 mt-1 tracking-tight">{value}</h3>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        <div
          className={`w-12 h-12 rounded-xl bg-gradient-to-br ${colorMap[color]} flex items-center justify-center border shadow-sm group-hover:scale-105 transition-transform duration-200`}
        >
          <Icon className="w-6 h-6" />
        </div>
      </div>

      {trend && (
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium">
          <span className={trend.isPositive ? 'text-emerald-400' : 'text-rose-400'}>
            {trend.isPositive ? '↑' : '↓'} {trend.value}
          </span>
          <span className="text-slate-500">vs last cycle</span>
        </div>
      )}
    </div>
  );
};
