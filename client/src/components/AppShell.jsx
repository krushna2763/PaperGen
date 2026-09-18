/**
 * AppShell — modern responsive application chrome matching reference design.
 * Fixed dark navy sidebar on desktop + responsive drawer on mobile/tablet.
 * Clean white top header with search, notifications, and teacher profile.
 */
import { useState } from 'react';
import {
  DashboardIcon,
  GeneratePaperIcon,
  MyPapersIcon,
  KnowledgeBaseIcon,
  TemplatesIcon,
  SettingsIcon,
  BellIcon,
  ChevronDownIcon,
  HelpCircleIcon,
  LogOutIcon,
  BookOpenIcon,
  SearchIcon,
  MenuIcon,
  XIcon,
} from './ui/icons.jsx';

const USER = { name: 'Teacher Sharma', institution: 'G H Raisoni College', initials: 'TS' };

const NAV = [
  { key: 'dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { key: 'generate', label: 'Generate paper', Icon: GeneratePaperIcon },
  { key: 'papers', label: 'My papers', Icon: MyPapersIcon },
  { key: 'kb', label: 'Knowledge base', Icon: KnowledgeBaseIcon },
  { key: 'templates', label: 'Templates', Icon: TemplatesIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export default function AppShell({
  view,
  onNavigate,
  notificationCount = 1,
  wide = false,
  children,
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleNavClick = (key) => {
    onNavigate(key);
    setMobileNavOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] text-gray-900 font-sans antialiased">
      {/* ── Mobile Sidebar Backdrop ──────────────────────────── */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs transition-opacity lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Dark Navy Sidebar (Desktop fixed + Mobile slide-over) ─ */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-[#0b132b] text-slate-300 transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="flex items-center justify-between px-5 pt-6 pb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-500/30">
              <BookOpenIcon size={20} />
            </span>
            <div className="leading-tight">
              <p className="text-[17px] font-bold text-white tracking-tight">PaperGen AI</p>
              <p className="text-[11.5px] text-slate-400 font-normal">AI Question Paper Generator</p>
            </div>
          </div>
          {/* Mobile Close Button */}
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <XIcon size={20} />
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="mt-3 flex-1 space-y-1.5 px-3.5">
          {NAV.map(({ key, label, Icon }) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleNavClick(key)}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13.5px] font-semibold transition-all ${
                  active
                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25'
                    : 'text-slate-300 hover:bg-white/8 hover:text-white font-medium'
                }`}
              >
                <Icon size={19} className={active ? 'text-white' : 'text-slate-400'} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar Bottom Area */}
        <div className="space-y-4 px-4 pb-6 pt-2">
          {/* Need help card */}
          <div className="rounded-xl border border-white/10 bg-white/[0.05] p-3.5 transition-colors hover:bg-white/[0.08]">
            <div className="flex items-center gap-2 text-white">
              <HelpCircleIcon size={16} className="text-slate-400" />
              <p className="text-[13px] font-semibold">Need help?</p>
            </div>
            <p className="mt-0.5 text-[11.5px] text-slate-400">Check our documentation</p>
          </div>

          {/* Teacher Profile */}
          <div className="flex items-center gap-3 px-1 py-1">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-[12.5px] font-bold text-white shadow-sm ring-2 ring-blue-400/30">
              {USER.initials}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-semibold text-white">{USER.name}</p>
              <p className="truncate text-[11px] text-slate-400">{USER.institution}</p>
            </div>
          </div>

          {/* Logout */}
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium text-slate-400 transition-colors hover:bg-white/8 hover:text-white"
          >
            <LogOutIcon size={17} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* ── Main Canvas (Offset for desktop sidebar) ───────── */}
      <div className="lg:pl-64 flex flex-col min-h-screen">
        {/* Top Header */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-gray-200/80 bg-white px-4 sm:px-8 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-3">
            {/* Mobile Hamburger Button */}
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 lg:hidden"
              aria-label="Open sidebar navigation"
            >
              <MenuIcon size={20} />
            </button>

            {/* Global Search Bar */}
            <div className="relative w-72 md:w-84 hidden sm:block">
              <SearchIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search papers, templates..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-full border border-gray-200/90 bg-gray-50/70 py-1.5 pl-9 pr-4 text-[13px] text-gray-800 placeholder-gray-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          </div>

          {/* Header Actions & Profile */}
          <div className="flex items-center gap-3 sm:gap-4">
            {/* Notification Bell */}
            <button
              type="button"
              className="relative flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              aria-label="Notifications"
            >
              <BellIcon size={19} />
              {notificationCount > 0 && (
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
              )}
            </button>

            <div className="h-6 w-px bg-gray-200 hidden sm:block" />

            {/* Teacher Profile Chip */}
            <div className="flex items-center gap-2.5 pl-1 cursor-pointer select-none">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-[12px] font-bold text-white shadow-xs">
                {USER.initials}
              </span>
              <div className="hidden sm:block text-left leading-tight">
                <p className="text-[13px] font-semibold text-gray-900">{USER.name}</p>
                <p className="text-[11px] text-gray-500">{USER.institution}</p>
              </div>
              <ChevronDownIcon size={14} className="text-gray-400" />
            </div>
          </div>
        </header>

        {/* Main View Area */}
        <main className={`flex-1 mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8 ${wide ? 'max-w-[1640px]' : 'max-w-7xl'}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
