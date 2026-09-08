import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

const queryClient = new QueryClient();

const workstreams = [
  { name: 'Product launch', detail: '8 tasks · 2 blockers', progress: 72, tone: 'coral' },
  { name: 'Q4 customer review', detail: '5 tasks · On track', progress: 46, tone: 'mint' },
  { name: 'Team rituals', detail: '3 tasks · Due today', progress: 88, tone: 'gold' },
];

function App() {
  return (
    <main className="min-h-screen bg-[#f4f0e8] text-[#102a2b]">
      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col px-6 py-6 sm:px-10 lg:px-16">
        <header className="flex items-center justify-between border-b border-[#102a2b]/15 pb-5">
          <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-[#102a2b] text-lg font-bold text-[#f5c5a8]">f</span><span className="text-xl font-semibold tracking-tight">flowryn</span></div>
          <div className="flex items-center gap-4 text-sm"><span className="hidden text-[#102a2b]/55 sm:inline">Monday, October 14</span><button className="rounded-full border border-[#102a2b]/20 px-4 py-2 font-medium transition hover:bg-white">JD <span className="ml-1 text-[#102a2b]/50">⌄</span></button></div>
        </header>
        <section className="grid flex-1 gap-12 py-12 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-20">
          <div className="max-w-xl"><p className="mb-5 text-sm font-semibold uppercase tracking-[0.22em] text-[#d7674d]">Your work, in motion</p><h1 className="font-display text-6xl leading-[0.94] tracking-[-0.04em] sm:text-8xl">Make space for <em className="text-[#d7674d]">better</em> work.</h1><p className="mt-8 max-w-md text-lg leading-8 text-[#102a2b]/65">Flowryn turns the moving parts of your day into a clear, intelligent rhythm.</p><button className="mt-9 rounded-full bg-[#d7674d] px-6 py-3 font-semibold text-white shadow-lg shadow-[#d7674d]/20 transition hover:-translate-y-0.5 hover:bg-[#c65740]">Open today&apos;s flow <span className="ml-3">↗</span></button></div>
          <div className="relative"><div className="absolute -inset-5 rounded-[2rem] bg-[#d7e6d7]/70 blur-2xl" /><div className="relative rounded-[1.5rem] border border-[#102a2b]/10 bg-white/70 p-5 shadow-xl shadow-[#102a2b]/10 backdrop-blur sm:p-7"><div className="flex items-start justify-between"><div><p className="text-sm font-semibold text-[#102a2b]/50">Overview</p><h2 className="mt-1 text-2xl font-semibold">A calm start</h2></div><span className="rounded-full bg-[#d7e6d7] px-3 py-1 text-xs font-bold text-[#356342]">+18% focus</span></div><div className="mt-8 grid grid-cols-3 gap-3 border-y border-[#102a2b]/10 py-5"><div><p className="text-2xl font-semibold">16</p><p className="mt-1 text-xs text-[#102a2b]/50">open tasks</p></div><div><p className="text-2xl font-semibold">04</p><p className="mt-1 text-xs text-[#102a2b]/50">in motion</p></div><div><p className="text-2xl font-semibold text-[#d7674d]">02:40</p><p className="mt-1 text-xs text-[#102a2b]/50">deep work</p></div></div><div className="mt-6"><div className="mb-3 flex items-center justify-between"><p className="text-sm font-semibold">Active workstreams</p><button className="text-xs font-semibold text-[#d7674d]">View all →</button></div><div className="space-y-4">{workstreams.map((stream) => <div key={stream.name}><div className="mb-2 flex justify-between text-sm"><span className="font-medium">{stream.name}</span><span className="text-[#102a2b]/45">{stream.progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-[#102a2b]/8"><div className={`h-full rounded-full ${stream.tone === 'coral' ? 'bg-[#d7674d]' : stream.tone === 'mint' ? 'bg-[#6d9f78]' : 'bg-[#e2b84b]'}`} style={{ width: `${stream.progress}%` }} /></div><p className="mt-1 text-xs text-[#102a2b]/45">{stream.detail}</p></div>)}</div></div></div></div>
        </section>
        <footer className="flex flex-col gap-3 border-t border-[#102a2b]/15 py-5 text-xs text-[#102a2b]/50 sm:flex-row sm:justify-between"><span>Intelligent Work Orchestration</span><span>Built for the way work actually moves.</span></footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>);