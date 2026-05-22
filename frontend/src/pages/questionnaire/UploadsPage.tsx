import { useState, useRef, DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '@/hooks/useAppContext';
import { ApiError } from '@/lib/api';

const ACCEPTED = '.pdf,.ppt,.pptx';
const MAX_SIZE_MB = 50;

interface UploadedFile {
  file: File;
  label: string;
}

type PageState = 'idle' | 'uploading' | 'preparing' | 'error';

export default function UploadsPage() {
  const { appId, token, isValid } = useAppContext();
  const navigate = useNavigate();

  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [pageState, setPageState] = useState<PageState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(newFiles: FileList | null) {
    if (!newFiles) return;
    const toAdd: UploadedFile[] = [];
    for (const f of Array.from(newFiles)) {
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        setErrorMsg(`${f.name} exceeds the ${MAX_SIZE_MB} MB limit.`);
        continue;
      }
      const label = f.name.toLowerCase().includes('pitch') ? 'Pitch deck' : 'Supporting document';
      toAdd.push({ file: f, label });
    }
    setFiles(prev => [...prev, ...toAdd].slice(0, 5));
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  async function submit() {
    if (!isValid) { setErrorMsg('Invalid link.'); return; }
    if (files.length === 0) { setErrorMsg('Please upload at least one document before continuing.'); return; }

    setErrorMsg('');
    setPageState('uploading');

    const fd = new FormData();
    for (const { file } of files) fd.append('files', file);

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? '/api'}/questionnaire/uploads?app=${appId}&token=${token}`,
        { method: 'POST', body: fd }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data.error ?? 'Upload failed');

      setPageState('preparing');
      // Poll for question plan readiness
      await pollForPlan();
      navigate(`/q/open?app=${appId}&token=${token}`);
    } catch (e) {
      setPageState('error');
      setErrorMsg(e instanceof ApiError ? e.message : 'Upload failed. Please try again.');
    }
  }

  async function pollForPlan(attempts = 0): Promise<void> {
    if (attempts > 30) throw new Error('Timeout waiting for question plan.');
    const res = await fetch(
      `${import.meta.env.VITE_API_URL ?? '/api'}/questionnaire/open-plan?app=${appId}&token=${token}`
    );
    const data = await res.json().catch(() => ({}));
    if (data.ready && Array.isArray(data.slots) && data.slots.length > 0) return;
    await new Promise(r => setTimeout(r, 3000));
    return pollForPlan(attempts + 1);
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      {/* Progress */}
      <div className="max-w-2xl mx-auto mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">Step 2 of 3 — Documents</span>
          <span className="text-sm text-gray-400">Optional but recommended</span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-2 bg-indigo-500 rounded-full w-2/3 transition-all" />
        </div>
      </div>

      <div className="max-w-2xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Upload your documents</h2>
            <p className="text-gray-500 text-sm mt-1">
              Upload your pitch deck and any supporting documents that demonstrate traction, technology, or
              team credentials. PDF and PowerPoint formats accepted. Maximum 50 MB per file.
            </p>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
              dragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              multiple
              className="hidden"
              onChange={e => addFiles(e.target.files)}
            />
            <svg className="w-10 h-10 mx-auto text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-sm font-medium text-gray-700">
              Drag and drop files here, or <span className="text-indigo-600 underline">browse</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">PDF, PPT, PPTX · Up to 5 files · 50 MB each</p>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map(({ file, label }, i) => (
                <li key={`${file.name}-${i}`} className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-3">
                  <svg className="w-5 h-5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                    <p className="text-xs text-gray-400">{label} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <button onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500 transition text-lg leading-none">×</button>
                </li>
              ))}
            </ul>
          )}

          {errorMsg && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{errorMsg}</p>
          )}

          {/* State feedback */}
          {pageState === 'preparing' && (
            <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-lg px-4 py-3">
              <span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm text-indigo-700">
                Preparing your personalised questions — this takes about 30 seconds…
              </p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => navigate(`/q/closed?app=${appId}&token=${token}`)}
              className="px-5 py-3 rounded-lg border border-gray-200 text-gray-700 font-medium hover:bg-gray-50 transition"
            >
              Back
            </button>
            <button
              onClick={submit}
              disabled={pageState === 'uploading' || pageState === 'preparing'}
              className="flex-1 py-3 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-60 transition"
            >
              {pageState === 'uploading' ? 'Uploading…' :
               pageState === 'preparing' ? 'Preparing questions…' :
               'Continue to Questions →'}
            </button>
          </div>

          <p className="text-xs text-gray-400 text-center">
            Documents are used only for evaluation purposes and are kept confidential.
          </p>
        </div>
      </div>
    </div>
  );
}
