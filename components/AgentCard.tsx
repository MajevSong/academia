import React from 'react';
import { AgentStatus } from '../types';
import { Activity, CheckCircle, Clock, AlertCircle } from 'lucide-react';

interface AgentCardProps {
  name: string;
  role: string;
  description: string;
  status: AgentStatus;
  icon: React.ReactNode;
}

const AgentCard: React.FC<AgentCardProps> = ({ name, role, description, status, icon }) => {
  const getStatusColor = () => {
    switch (status) {
      case AgentStatus.WORKING: return 'border-amber-500/50 bg-amber-500/10 text-amber-500';
      case AgentStatus.COMPLETED: return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500';
      case AgentStatus.ERROR: return 'border-red-500/50 bg-red-500/10 text-red-500';
      case AgentStatus.IDLE: 
      default: return 'border-zinc-800 bg-zinc-900/50 text-zinc-500';
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case AgentStatus.WORKING: return <Activity className="w-4 h-4 animate-pulse" />;
      case AgentStatus.COMPLETED: return <CheckCircle className="w-4 h-4" />;
      case AgentStatus.ERROR: return <AlertCircle className="w-4 h-4" />;
      default: return <Clock className="w-4 h-4" />;
    }
  };

  return (
    <div className={`relative p-4 rounded-lg border backdrop-blur-sm transition-all duration-300 ${getStatusColor()}`}>
      <div className="flex justify-between items-start mb-2">
        <div className="p-2 rounded-md bg-zinc-950/50 border border-zinc-800 text-white">
          {icon}
        </div>
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider">
          {getStatusIcon()}
          <span>{status}</span>
        </div>
      </div>
      <h3 className="text-lg font-bold text-white mb-1">{name}</h3>
      <p className="text-xs font-mono text-zinc-400 uppercase tracking-widest mb-2">{role}</p>
      <p className="text-sm text-zinc-300 opacity-80 leading-relaxed">{description}</p>
      
      {status === AgentStatus.WORKING && (
        <div className="absolute bottom-0 left-0 w-full h-1 bg-zinc-800 overflow-hidden rounded-b-lg">
          <div className="h-full bg-current animate-progress-indeterminate opacity-50"></div>
        </div>
      )}
    </div>
  );
};

export default AgentCard;