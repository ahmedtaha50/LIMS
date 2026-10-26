import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Loader2, Volume2, Sparkles } from 'lucide-react';
import { useToast } from './ui/Toast';

interface VoiceRecorderProps {
  onTranscription: (text: string) => void;
  token: string;
}

/**
 * Hands-free dictation. The recording goes to /api/transcribe, which answers only when an Administrator has switched external AI on;
 * otherwise it answers 503 AI_DISABLED and this component shows that as an error. Nothing is substituted for a failed transcription:
 * not a canned sentence, and not the browser's own speech engine (which in many browsers sends the audio to a third party without
 * the audit record the server writes). What comes back is a draft: it is labelled, and the analyst edits and signs the entry.
 */
export function VoiceRecorder({ onTranscription, token }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const { toast } = useToast();

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      setRecordSeconds(0);
      setDraftLabel(null);

      // Start elapsed timer
      timerRef.current = setInterval(() => {
        setRecordSeconds(sec => sec + 1);
      }, 1000);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (timerRef.current) clearInterval(timerRef.current);
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop());

        setIsProcessing(true);
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });

        // Convert Blob to a base64 data URL to send to /api/transcribe
        const reader = new FileReader();
        reader.onerror = () => {
          setIsProcessing(false);
          toast('The recording could not be read. Nothing was transcribed.', 'error');
        };
        reader.onloadend = async () => {
          if (reader.error) return;
          try {
            const res = await fetch('/api/transcribe', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ audio: reader.result })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status}).`);

            if (data.text) {
              onTranscription(data.text);
              setDraftLabel(data.generatedBy?.label || 'AI draft - not a GxP record');
              toast('Transcription inserted as an AI draft. Read and correct it before you save or sign.', 'info');
            } else {
              toast('No speech detected in the recording', 'info');
            }
          } catch (err: any) {
            toast(err.message || 'Transcription failed', 'error');
          } finally {
            setIsProcessing(false);
          }
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      toast('Cleanroom microphone active: Speak your observations...', 'info');
    } catch (err) {
      toast('Microphone access denied or unavailable.', 'error');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-2">
      {!isRecording && !isProcessing && (
        <button
          type="button"
          onClick={startRecording}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold transition-colors border border-blue-200 shadow-2xs"
          title="Hands-free voice dictation for sterile glove operation. Uses external AI, which an Administrator must switch on."
        >
          <Mic className="w-3.5 h-3.5 text-blue-600" />
          <span>Cleanroom Voice Dictation</span>
        </button>
      )}

      {isRecording && (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 rounded-lg text-xs font-mono font-bold border border-red-200">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
            <Volume2 className="w-3.5 h-3.5" />
            <span>Rec {formatTimer(recordSeconds)}</span>
          </div>
          <button
            type="button"
            onClick={stopRecording}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
          >
            <Square className="w-3.5 h-3.5" /> Complete Dictation
          </button>
        </div>
      )}

      {isProcessing && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold border border-indigo-200 animate-pulse">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />
          <span>Transcribing via external AI...</span>
        </div>
      )}

      {draftLabel && !isRecording && !isProcessing && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-800 rounded-lg text-xs font-semibold border border-amber-300" role="status">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{draftLabel}: review and edit before saving</span>
        </div>
      )}
    </div>
  );
}
