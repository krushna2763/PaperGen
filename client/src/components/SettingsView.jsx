/**
 * SettingsView — teacher preferences and paper generation configuration.
 */
import { useState } from 'react';
import { SettingsIcon, CircleCheckSolid, SlidersIcon } from './ui/icons.jsx';

export default function SettingsView() {
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    teacherName: 'Teacher Sharma',
    institution: 'G H Raisoni College',
    defaultClass: '10',
    defaultExamTitle: 'Annual Examination',
    defaultDuration: '3 Hours',
    defaultMarks: '80',
    includeAnswerKeyByDefault: true,
  });

  const handleSave = (e) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Settings &amp; Preferences</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure default header information, examination details, and teacher profile.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Profile Card */}
        <div className="rounded-2xl border border-gray-200/90 bg-white p-6 shadow-xs">
          <div className="flex items-center gap-2.5 pb-4 border-b border-gray-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <SettingsIcon size={18} />
            </span>
            <h2 className="text-[15px] font-bold text-gray-900">Teacher &amp; Institution Profile</h2>
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Teacher Name</label>
              <input
                type="text"
                value={form.teacherName}
                onChange={(e) => setForm({ ...form, teacherName: e.target.value })}
                className="w-full h-10 px-3.5 text-sm rounded-xl border border-gray-200 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">College / Institution</label>
              <input
                type="text"
                value={form.institution}
                onChange={(e) => setForm({ ...form, institution: e.target.value })}
                className="w-full h-10 px-3.5 text-sm rounded-xl border border-gray-200 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
          </div>
        </div>

        {/* Paper Defaults Card */}
        <div className="rounded-2xl border border-gray-200/90 bg-white p-6 shadow-xs">
          <div className="flex items-center gap-2.5 pb-4 border-b border-gray-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
              <SlidersIcon size={18} />
            </span>
            <h2 className="text-[15px] font-bold text-gray-900">Default Paper Settings</h2>
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Default Class</label>
              <input
                type="text"
                value={form.defaultClass}
                onChange={(e) => setForm({ ...form, defaultClass: e.target.value })}
                className="w-full h-10 px-3.5 text-sm rounded-xl border border-gray-200 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Examination Title</label>
              <input
                type="text"
                value={form.defaultExamTitle}
                onChange={(e) => setForm({ ...form, defaultExamTitle: e.target.value })}
                className="w-full h-10 px-3.5 text-sm rounded-xl border border-gray-200 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1.5">Default Duration</label>
              <input
                type="text"
                value={form.defaultDuration}
                onChange={(e) => setForm({ ...form, defaultDuration: e.target.value })}
                className="w-full h-10 px-3.5 text-sm rounded-xl border border-gray-200 bg-gray-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">
            <div>
              <p className="text-[13px] font-semibold text-gray-800">Generate Separate Answer Key</p>
              <p className="text-[11.5px] text-gray-500">Automatically produce marking scheme and answers document on generation.</p>
            </div>
            <input
              type="checkbox"
              checked={form.includeAnswerKeyByDefault}
              onChange={(e) => setForm({ ...form, includeAnswerKeyByDefault: e.target.checked })}
              className="h-4 w-4 rounded accent-blue-600"
            />
          </div>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="h-10 px-5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-xs transition-colors"
          >
            Save Preferences
          </button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg">
              <CircleCheckSolid size={13} className="text-emerald-500" />
              Settings saved successfully!
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
