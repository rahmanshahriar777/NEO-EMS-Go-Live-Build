'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// Web Speech API interface declarations for TypeScript compatibility
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: {
    length: number;
    item(index: number): {
      length: number;
      item(index: number): {
        transcript: string;
        confidence: number;
      };
      isFinal: boolean;
      [index: number]: { transcript: string; confidence: number };
    };
    [index: number]: {
      length: number;
      isFinal: boolean;
      [index: number]: { transcript: string; confidence: number };
    };
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: ((this: SpeechRecognitionLike, ev: Event) => any) | null;
  onend: ((this: SpeechRecognitionLike, ev: Event) => any) | null;
  onerror: ((this: SpeechRecognitionLike, ev: SpeechRecognitionErrorEventLike) => any) | null;
  onresult: ((this: SpeechRecognitionLike, ev: SpeechRecognitionEventLike) => any) | null;
  onspeechstart?: ((this: SpeechRecognitionLike, ev: Event) => any) | null;
  onspeechend?: ((this: SpeechRecognitionLike, ev: Event) => any) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface UseSpeechOptions {
  lang?: string;
  autoSubmitDelayMs?: number;
  onTranscriptChange?: (transcript: string) => void;
  onFinalTranscript?: (transcript: string) => void;
}

export function useSpeech(options: UseSpeechOptions = {}) {
  const {
    lang = 'en-US',
    autoSubmitDelayMs = 1800,
    onTranscriptChange,
    onFinalTranscript,
  } = options;

  // Recognition state
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [sttSupported, setSttSupported] = useState(false);

  // Synthesis state
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);

  // Auto-speak preference
  const [autoSpeak, setAutoSpeak] = useState(true);

  // Refs for tracking recognition instance and timers
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const latestTranscriptRef = useRef<string>('');
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const currentUtterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const isManuallyStoppedRef = useRef<boolean>(false);
  const onTranscriptChangeRef = useRef(onTranscriptChange);
  const onFinalTranscriptRef = useRef(onFinalTranscript);

  // Keep callback refs updated without causing re-subscriptions
  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange;
  }, [onTranscriptChange]);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  // Check support on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognitionConstructor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition ||
      (window as any).mozSpeechRecognition ||
      (window as any).msSpeechRecognition;

    setSttSupported(!!SpeechRecognitionConstructor);
    setTtsSupported('speechSynthesis' in window);

    if ('speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis;

      const loadVoices = () => {
        const availableVoices = window.speechSynthesis.getVoices();
        setVoices(availableVoices);

        // Pick preferred default natural English voice
        if (availableVoices.length > 0 && !selectedVoice) {
          const naturalVoice =
            availableVoices.find(
              (v) =>
                (v.name.includes('Natural') ||
                  v.name.includes('Google') ||
                  v.name.includes('Samantha') ||
                  v.name.includes('Jenny') ||
                  v.name.includes('Premium')) &&
                v.lang.startsWith('en')
            ) ||
            availableVoices.find((v) => v.lang.startsWith('en')) ||
            availableVoices[0];

          setSelectedVoice(naturalVoice);
        }
      };

      loadVoices();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
      }
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
      if (synthRef.current) {
        try {
          synthRef.current.cancel();
        } catch {}
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, []);

  // Helper to sanitize markdown text for speech synthesis
  const cleanMarkdownForSpeech = (text: string): string => {
    if (!text) return '';
    return text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, 'Code snippet omitted.')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove markdown headings
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold & italic
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
      // Remove URLs
      .replace(/https?:\/\/\S+/g, 'link')
      // Remove markdown links [text](url)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove blockquotes
      .replace(/^\s*>\s+/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Replace bullet points with pause
      .replace(/^[\s*-+]\s+/gm, ', ')
      // Clean up excess whitespace
      .replace(/\n+/g, '. ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  // Text-to-Speech synthesis
  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    currentUtterancesRef.current = [];
    setIsSpeaking(false);
    setIsPaused(false);
  }, []);

  const pauseSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis && isSpeaking) {
      window.speechSynthesis.pause();
      setIsPaused(true);
    }
  }, [isSpeaking]);

  const resumeSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis && isPaused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    }
  }, [isPaused]);

  // Speak response chunk-by-chunk for maximum reliability
  const speak = useCallback(
    (textToSpeak: string, onEndCallback?: () => void) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;

      stopSpeaking();

      const cleaned = cleanMarkdownForSpeech(textToSpeak);
      if (!cleaned) return;

      const sentenceRegex = /[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g;
      const chunks = cleaned.match(sentenceRegex) || [cleaned];

      currentUtterancesRef.current = [];

      const utterances: SpeechSynthesisUtterance[] = chunks
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0)
        .map((chunk, index, arr) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          if (selectedVoice) {
            utterance.voice = selectedVoice;
          }
          utterance.rate = 1.0;
          utterance.pitch = 1.0;

          if (index === arr.length - 1) {
            utterance.onend = () => {
              setIsSpeaking(false);
              setIsPaused(false);
              if (onEndCallback) onEndCallback();
            };
          }

          utterance.onerror = (e) => {
            if (e.error !== 'canceled' && e.error !== 'interrupted') {
              console.warn('Speech synthesis error:', e);
            }
            if (index === arr.length - 1) {
              setIsSpeaking(false);
              setIsPaused(false);
            }
          };

          return utterance;
        });

      if (utterances.length === 0) return;

      currentUtterancesRef.current = utterances;
      setIsSpeaking(true);
      setIsPaused(false);

      utterances.forEach((u) => {
        window.speechSynthesis.speak(u);
      });
    },
    [selectedVoice, stopSpeaking]
  );

  // Trigger submission of the current transcript
  const triggerAutoSubmit = useCallback(() => {
    const textToSubmit = latestTranscriptRef.current.trim();
    if (textToSubmit) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      setIsListening(false);
      if (onFinalTranscriptRef.current) {
        onFinalTranscriptRef.current(textToSubmit);
      }
    }
  }, []);

  // Start speech recognition
  const startListening = useCallback(async () => {
    if (typeof window === 'undefined') return;

    // Stop audio output if currently speaking
    stopSpeaking();

    const SpeechRecognitionConstructor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition ||
      (window as any).mozSpeechRecognition ||
      (window as any).msSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      setRecognitionError(
        'Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.'
      );
      return;
    }

    // Explicitly prompt/verify microphone permissions first
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Immediately release stream tracks so SpeechRecognition has uncontended access
        stream.getTracks().forEach((track) => track.stop());
      } catch (permErr: any) {
        if (
          permErr.name === 'NotAllowedError' ||
          permErr.name === 'PermissionDeniedError' ||
          permErr.message?.includes('Permission denied')
        ) {
          setRecognitionError(
            'Microphone access was denied. Please allow microphone permissions in your browser address bar and try again.'
          );
          setIsListening(false);
          return;
        }
      }
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      const recognition: SpeechRecognitionLike = new SpeechRecognitionConstructor();
      // Use continuous=true so recognition does not abruptly stop on brief pauses
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = lang;
      recognition.maxAlternatives = 1;

      latestTranscriptRef.current = '';
      isManuallyStoppedRef.current = false;
      setTranscript('');
      setInterimTranscript('');
      setRecognitionError(null);

      recognition.onstart = () => {
        setIsListening(true);
        setRecognitionError(null);
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let accumulatedFinal = '';
        let currentInterim = '';

        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          const text = res[0].transcript;
          if (res.isFinal) {
            accumulatedFinal += text;
          } else {
            currentInterim += text;
          }
        }

        const combinedText = (accumulatedFinal + (currentInterim ? ' ' + currentInterim : '')).trim();

        if (combinedText) {
          latestTranscriptRef.current = combinedText;
          setTranscript(accumulatedFinal.trim());
          setInterimTranscript(currentInterim.trim());

          // Instantly notify listener so words appear in the chat / prompt immediately
          if (onTranscriptChangeRef.current) {
            onTranscriptChangeRef.current(combinedText);
          }

          // Reset silence timer: if user stops speaking for autoSubmitDelayMs, auto-submit!
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(() => {
            triggerAutoSubmit();
          }, autoSubmitDelayMs);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (event.error === 'no-speech') {
          return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setRecognitionError(
            'Microphone access denied. Please allow microphone permissions in your browser.'
          );
        } else if (event.error !== 'aborted') {
          setRecognitionError(`Speech recognition error: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        const finalText = latestTranscriptRef.current.trim();
        if (finalText && !isManuallyStoppedRef.current) {
          if (onFinalTranscriptRef.current) {
            onFinalTranscriptRef.current(finalText);
          }
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      setRecognitionError(err?.message || 'Could not start speech recognition');
      setIsListening(false);
    }
  }, [lang, autoSubmitDelayMs, stopSpeaking, triggerAutoSubmit]);

  // Stop speech recognition manually and submit
  const stopListening = useCallback(() => {
    isManuallyStoppedRef.current = true;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    setIsListening(false);

    const textToSubmit = latestTranscriptRef.current.trim();
    if (textToSubmit && onFinalTranscriptRef.current) {
      onFinalTranscriptRef.current(textToSubmit);
    }
  }, []);

  // Cancel listening without submitting
  const cancelListening = useCallback(() => {
    isManuallyStoppedRef.current = true;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {}
    }
    setIsListening(false);
    latestTranscriptRef.current = '';
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    // STT
    isListening,
    transcript,
    interimTranscript,
    recognitionError,
    sttSupported,
    startListening,
    stopListening,
    cancelListening,

    // TTS
    isSpeaking,
    isPaused,
    ttsSupported,
    voices,
    selectedVoice,
    setSelectedVoice,
    speak,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,

    // Preferences
    autoSpeak,
    setAutoSpeak,
  };
}
