'use client';

import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  Camera,
  Trash2,
  Check,
  Image as ImageIcon,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import { useAuth } from '../../context/auth-context';

interface AvatarModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (newAvatarUrl: string | null) => void;
}

// Curated corporate avatar presets for easy 1-click selection
const PRESET_AVATARS = [
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=256&h=256&fit=crop&crop=faces',
  'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=256&h=256&fit=crop&crop=faces',
];

export const AvatarModal: React.FC<AvatarModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { user, updateUserAvatar } = useAuth();
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(user?.avatarUrl || null);
  const [customUrl, setCustomUrl] = useState('');
  const [activeTab, setActiveTab] = useState<'upload' | 'presets' | 'url'>('upload');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // Handle local file selection and convert to Base64
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file (PNG, JPG, JPEG, WebP, or GIF).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError('Image size exceeds 5MB limit. Please select a smaller photo.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Url = event.target?.result as string;
      setSelectedAvatar(base64Url);
    };
    reader.onerror = () => {
      setError('Failed to read selected image file.');
    };
    reader.readAsDataURL(file);
  };

  // Handle applying custom URL
  const handleApplyUrl = () => {
    if (!customUrl.trim()) return;
    try {
      new URL(customUrl.trim());
      setSelectedAvatar(customUrl.trim());
      setError(null);
    } catch {
      setError('Please enter a valid image URL starting with http:// or https://');
    }
  };

  // Save changes to backend
  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await api.patch<{ employeeId: string; avatarUrl: string | null }>(
        '/employees/me/avatar',
        {
          avatarUrl: selectedAvatar || '',
        },
      );

      const updatedUrl = (res as any)?.data?.avatarUrl || (res as any)?.avatarUrl || null;
      updateUserAvatar(updatedUrl);
      onSuccess?.(updatedUrl);

      setSuccessMessage('Profile picture updated successfully!');
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err: any) {
      setError(err?.message || 'Failed to update profile picture. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = () => {
    setSelectedAvatar(null);
    setCustomUrl('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-primary-50 text-primary-600 flex items-center justify-center">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Set Profile Picture</h2>
              <p className="text-xs text-slate-500">
                Personalize your account for employee directory and records
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Avatar Preview Hero */}
          <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
            <div className="relative group shrink-0">
              {selectedAvatar ? (
                <img
                  src={selectedAvatar}
                  alt="Profile Avatar Preview"
                  className="w-20 h-20 rounded-full object-cover border-2 border-primary-500 shadow-md ring-4 ring-primary-50"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-primary-600 to-indigo-600 border-2 border-dashed border-primary-400 flex items-center justify-center text-white text-xl font-bold shadow-md">
                  {user?.firstName?.[0] || 'U'}
                  {user?.lastName?.[0] || ''}
                </div>
              )}

              {selectedAvatar && (
                <button
                  type="button"
                  onClick={handleRemove}
                  title="Remove picture"
                  className="absolute -top-1 -right-1 p-1.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-md transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="text-center sm:text-left flex-1 min-w-0">
              <h3 className="text-sm font-bold text-slate-900 truncate">
                {user?.firstName} {user?.lastName}
              </h3>
              <p className="text-xs text-slate-500 truncate">{user?.email}</p>
              <div className="flex items-center gap-2 mt-2 justify-center sm:justify-start">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-semibold">
                  {user?.employeeNumber || 'EMPLOYEE'}
                </span>
                {selectedAvatar ? (
                  <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-1">
                    <Check className="w-3 h-3" /> Photo Selected
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400">Default Initials</span>
                )}
              </div>
            </div>
          </div>

          {/* Source Tabs */}
          <div className="flex border-b border-slate-200">
            <button
              type="button"
              onClick={() => setActiveTab('upload')}
              className={`flex-1 py-2.5 text-xs font-semibold border-b-2 transition flex items-center justify-center gap-1.5 ${
                activeTab === 'upload'
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Photo
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('presets')}
              className={`flex-1 py-2.5 text-xs font-semibold border-b-2 transition flex items-center justify-center gap-1.5 ${
                activeTab === 'presets'
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Preset Avatars
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('url')}
              className={`flex-1 py-2.5 text-xs font-semibold border-b-2 transition flex items-center justify-center gap-1.5 ${
                activeTab === 'url'
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Photo URL
            </button>
          </div>

          {/* Tab 1: Upload from device */}
          {activeTab === 'upload' && (
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png, image/jpeg, image/webp, image/gif"
                onChange={handleFileChange}
                className="hidden"
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-200 hover:border-primary-500 rounded-2xl p-6 text-center cursor-pointer transition bg-slate-50/50 hover:bg-primary-50/20 group"
              >
                <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 text-slate-400 group-hover:text-primary-600 group-hover:border-primary-300 flex items-center justify-center mx-auto mb-3 shadow-xs transition">
                  <Upload className="w-6 h-6" />
                </div>
                <p className="text-sm font-semibold text-slate-800">
                  Click to choose a photo or drag & drop
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Supported formats: PNG, JPG, WebP, GIF (Max: 5MB)
                </p>
              </div>
            </div>
          )}

          {/* Tab 2: Corporate Presets */}
          {activeTab === 'presets' && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                Choose a professional preset corporate avatar:
              </p>
              <div className="grid grid-cols-4 gap-3">
                {PRESET_AVATARS.map((preset, idx) => {
                  const isSelected = selectedAvatar === preset;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedAvatar(preset)}
                      className={`relative rounded-2xl overflow-hidden aspect-square border-2 transition group ${
                        isSelected
                          ? 'border-primary-600 ring-4 ring-primary-100 shadow-md scale-105'
                          : 'border-slate-200 hover:border-slate-400'
                      }`}
                    >
                      <img
                        src={preset}
                        alt={`Preset ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      {isSelected && (
                        <div className="absolute inset-0 bg-primary-600/30 flex items-center justify-center text-white">
                          <Check className="w-5 h-5 drop-shadow-md" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 3: Custom URL */}
          {activeTab === 'url' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Image Direct URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    placeholder="https://example.com/avatar.jpg"
                    className="flex-1 px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-hidden focus:border-primary-500"
                  />
                  <button
                    type="button"
                    onClick={handleApplyUrl}
                    className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
                  >
                    Apply
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  You can paste links from Gravatar, LinkedIn, Unsplash, or intranet servers.
                </p>
              </div>
            </div>
          )}

          {/* Feedback messages */}
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2 text-rose-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center gap-2 text-emerald-700 text-xs">
              <Check className="w-4 h-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <div>
            {selectedAvatar && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={loading}
                className="text-xs font-medium text-rose-600 hover:text-rose-700 transition"
              >
                Clear Picture
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-semibold transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={loading}
              className="px-5 py-2 rounded-xl bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold shadow-xs transition flex items-center gap-2 disabled:opacity-60"
            >
              {loading ? (
                <>
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Save Picture</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
