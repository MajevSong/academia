import React, { useState, useEffect } from 'react';
import { Key, Lock, X, Cloud } from 'lucide-react';

interface ApiKeyModalProps {
    onSave: (key: string) => void;
    onCancel: () => void;
    isOpen: boolean;
}

const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ onSave, onCancel, isOpen }) => {
    const [keyInput, setKeyInput] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) {
            setKeyInput('');
            setError(null);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (keyInput.length < 20 || !keyInput.startsWith('AI')) {
            setError('Invalid API Key format. It should start with "AI" and be long.');
            return;
        }
        onSave(keyInput);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-zinc-900 border border-blue-500/30 rounded-xl shadow-2xl max-w-md w-full p-6 ring-1 ring-blue-500/20">
                <div className="flex items-center gap-3 mb-6 text-blue-400">
                    <div className="p-3 bg-blue-500/10 rounded-lg">
                        <Lock className="w-6 h-6" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white">Gemini API Key</h2>
                        <p className="text-zinc-400 text-xs">Enter your Google AI Studio Key</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">API Key</label>
                        <div className="relative">
                            <Key className="absolute left-3 top-2.5 w-4 h-4 text-zinc-600" />
                            <input
                                type="password"
                                value={keyInput}
                                onChange={(e) => {
                                    setKeyInput(e.target.value);
                                    setError(null);
                                }}
                                placeholder="AIzaSy..."
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-white focus:ring-2 focus:ring-blue-500/50 outline-none font-mono text-sm"
                                autoFocus
                            />
                        </div>
                        {error && <p className="text-red-400 text-xs">{error}</p>}
                    </div>

                    <div className="text-xs text-zinc-500 bg-zinc-950/50 p-3 rounded border border-zinc-800">
                        <strong className="text-zinc-400 block mb-1">Privacy Note:</strong>
                        Your API Key is stored locally in your browser (LocalStorage). It is never sent to our servers.
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="text-zinc-400 hover:text-white text-sm px-4 py-2 transition-colors"
                        >
                            Cancel (Use Ollama)
                        </button>
                        <button
                            type="submit"
                            disabled={!keyInput}
                            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-bold transition-colors flex items-center gap-2"
                        >
                            <Cloud className="w-4 h-4" />
                            Save Key
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ApiKeyModal;
