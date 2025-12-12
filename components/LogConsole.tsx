import React, { useRef, useEffect } from 'react';
import { LogEntry } from '../types';
import { Terminal } from 'lucide-react';

interface LogConsoleProps {
  logs: LogEntry[];
}

const LogConsole: React.FC<LogConsoleProps> = ({ logs }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden flex flex-col h-64 md:h-full">
      <div className="bg-zinc-900 border-b border-zinc-800 px-3 py-2 flex items-center gap-2">
        <Terminal className="w-4 h-4 text-zinc-400" />
        <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest">System Protocol Logs</span>
      </div>
      <div 
        ref={scrollRef}
        className="flex-1 p-4 overflow-y-auto font-mono text-xs space-y-2 custom-scrollbar"
      >
        {logs.length === 0 && (
          <div className="text-zinc-600 italic">Waiting for input stream...</div>
        )}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-3">
            <span className="text-zinc-500 whitespace-nowrap">[{log.timestamp}]</span>
            <span className={`font-bold uppercase whitespace-nowrap w-24 ${
              log.agent === 'SYSTEM' ? 'text-blue-400' :
              log.agent === 'LIBRARIAN' ? 'text-purple-400' :
              log.agent === 'DATA' ? 'text-cyan-400' :
              log.agent === 'WRITER' ? 'text-pink-400' :
              'text-orange-400'
            }`}>
              {log.agent}
            </span>
            <span className={`${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'success' ? 'text-emerald-400' :
              log.type === 'warning' ? 'text-amber-400' :
              'text-zinc-300'
            }`}>
              {log.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LogConsole;