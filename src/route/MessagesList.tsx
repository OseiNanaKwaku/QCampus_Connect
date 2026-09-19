import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import AppHeader from '../components/AppHeader';
import Sidebar from '../components/Sidebar';
import Footer from '../components/Footer';
import { AttachmentLink, AttachmentPicker, uploadAttachment } from '../components/AttachmentTools';
import { useAuth } from '../context/AuthContext.jsx';
import { BB84KeyModal } from '../components/BB84KeyModal';
import {
  performBB84KeyExchange,
  encryptTextMessage,
  decryptTextMessage,
  encryptFile,
  decryptFile,
} from '../services/keyExchange';
import '../route_css/MessagesList.css';

const convexApi = api as any;
const DEFAULT_CHAT_DRAWER_WIDTH = 448;
const MIN_CHAT_DRAWER_WIDTH = 360;
const MAX_CHAT_DRAWER_WIDTH = 900;

type ChatUser = {
  _id: Id<'users'>;
  fullName: string;
  email: string;
  role: 'student' | 'lecturer';
  school: string;
  avatarUrl?: string;
  isVerified: boolean;
};

type Room = {
  _id: Id<'chatRooms'>;
  otherUser: ChatUser | null;
  preview: string;
  lastMessageAt: number;
  unread: number;
  bb84Fingerprint?: string;
  bb84PendingConfirmation?: boolean;
};

type ChatMessage = {
  _id: Id<'messages'>;
  text: string;
  iv?: string;
  isEncrypted?: boolean;
  createdAt: number;
  isMine: boolean;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentType?: string;
  attachmentSize?: number;
  editedAt?: number;
  blockchainTxHash?: string;
};

type RoomDetails = {
  _id: Id<'chatRooms'>;
  title?: string;
  participantIds: Id<'users'>[];
  otherUser: ChatUser | null;
  bb84Key?: string;
  bb84Fingerprint?: string;
  bb84ConfirmedUsers?: Id<'users'>[];
  bb84Status?: 'pending' | 'active' | 'confirmed';
  status?: 'pending' | 'active' | 'confirmed';
};

const clampChatDrawerWidth = (width: number) => {
  const viewportMax = Math.max(MIN_CHAT_DRAWER_WIDTH, window.innerWidth - 96);
  return Math.min(Math.max(width, MIN_CHAT_DRAWER_WIDTH), Math.min(MAX_CHAT_DRAWER_WIDTH, viewportMax));
};

const formatTime = (timestamp?: number) => {
  if (!timestamp) return 'Now';
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const getInitials = (name: string) => name
  .split(' ')
  .filter(Boolean)
  .slice(0, 2)
  .map(part => part[0])
  .join('')
  .toUpperCase();

const MessagesList = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentUser, sessionToken, isLoading: authLoading } = useAuth();
  const rooms = useQuery(convexApi.qchat.getRooms, sessionToken ? { sessionToken } : 'skip') as Room[] | undefined;
  const generateUploadUrl = useMutation(convexApi.qchat.generateUploadUrl);
  const sendMessage = useMutation(convexApi.qchat.sendMessage);
  const markAsRead = useMutation(convexApi.qchat.markAsRead);
  const deleteMessage = useMutation(convexApi.qchat.deleteMessage);
  const editMessage = useMutation(convexApi.qchat.editMessage);

  // BB84 Convex mutations
  const initiateBB84KeyExchange = useMutation(convexApi.qchat.initiateBB84KeyExchange);
  const confirmBB84Key = useMutation(convexApi.qchat.confirmBB84Key);

  const resetBB84KeyExchange = useMutation(convexApi.qchat.resetBB84KeyExchange);

  const requestedRoomId = searchParams.get('roomId') as Id<'chatRooms'> | null;
  const [activeRoomId, setActiveRoomId] = useState<Id<'chatRooms'> | null>(requestedRoomId);
  const prevActiveRoomIdRef = useRef<Id<'chatRooms'> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'unread'>('all');
  const [newMessage, setNewMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [chatDrawerWidth, setChatDrawerWidth] = useState(() => clampChatDrawerWidth(DEFAULT_CHAT_DRAWER_WIDTH));
  const [isResizingChat, setIsResizingChat] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // BB84 & AES Decryption state
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [isSimulatingBB84, setIsSimulatingBB84] = useState(false);
  // Full simulation details kept in local state only (never sent to Convex) for educational debug view
  const [decryptedTexts, setDecryptedTexts] = useState<Record<string, string>>({});
  const [decryptingFileId, setDecryptingFileId] = useState<string | null>(null);

  // Long-press / context-menu state
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<Id<'messages'> | null>(null);
  const [editText, setEditText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const roomDetails = useQuery(
    convexApi.qchat.getRoomDetails,
    sessionToken && activeRoomId ? { sessionToken, roomId: activeRoomId } : 'skip',
  ) as RoomDetails | null | undefined;

  const messages = useQuery(
    convexApi.qchat.getMessages,
    sessionToken && activeRoomId ? { sessionToken, roomId: activeRoomId } : 'skip',
  ) as ChatMessage[] | undefined;

  useEffect(() => {
    if (!sessionToken && !authLoading) navigate('/login');
  }, [authLoading, navigate, sessionToken]);

  useEffect(() => {
    if (requestedRoomId) setActiveRoomId(requestedRoomId);
  }, [requestedRoomId]);

  useEffect(() => {
    if (!sessionToken || !activeRoomId) return;
    void markAsRead({ sessionToken, roomId: activeRoomId }).catch(() => undefined);
  }, [activeRoomId, markAsRead, sessionToken, messages?.length]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeRoomId, messages?.length]);

  // Automated BB84 key simulation trigger when active room has no key yet
  useEffect(() => {
    if (!sessionToken || !activeRoomId || !roomDetails) return;

    if (!roomDetails.bb84Key && !isSimulatingBB84) {
      setIsSimulatingBB84(true);
      void (async () => {
        try {
          console.log('[BB84] Initiating automated quantum key exchange simulation...');
          const result = await performBB84KeyExchange();
          // Store full simulation details locally for the educational debug modal
          // Send only the 4 summary fields to Convex (Convex validator rejects extra fields)
          await initiateBB84KeyExchange({
            sessionToken,
            roomId: activeRoomId,
            bb84Key: result.sharedKeyHex,
            bb84Fingerprint: result.fingerprint,
            debugInfo: {
              totalBitsSent: result.details.totalBitsSent,
              siftedLength: result.details.siftedLength,
              efficiencyPercentage: result.details.efficiencyPercentage,
              qber: result.details.qber,
            },
          });
          setShowKeyModal(true);
        } catch (err) {
          console.error('Failed to run BB84 key exchange:', err);
        } finally {
          setIsSimulatingBB84(false);
        }
      })();
    }
  }, [activeRoomId, initiateBB84KeyExchange, isSimulatingBB84, roomDetails, sessionToken]);

  // Open modal when entering a room: always if unconfirmed
  useEffect(() => {
    if (roomDetails?.bb84Fingerprint && currentUser?._id) {
      const isConfirmed = roomDetails.bb84ConfirmedUsers?.includes(currentUser._id);
      const isSessionConfirmed = roomDetails.status === 'confirmed' || roomDetails.bb84Status === 'confirmed';
      if (!isConfirmed && !isSessionConfirmed) {
        // Unconfirmed — must confirm before chatting
        setShowKeyModal(true);
      }
    }
  }, [activeRoomId, currentUser?._id, roomDetails?.bb84ConfirmedUsers, roomDetails?.bb84Fingerprint, roomDetails?.status, roomDetails?.bb84Status]);

  // Real-time synchronization: Close the BB84 modal immediately on both screens when session status becomes "confirmed"
  useEffect(() => {
    if (roomDetails?.status === 'confirmed' || roomDetails?.bb84Status === 'confirmed') {
      setShowKeyModal(false);
    }
  }, [roomDetails?.status, roomDetails?.bb84Status]);

  // Decrypt encrypted text messages client-side using Web Crypto AES-GCM
  useEffect(() => {
    if (!messages || !roomDetails?.bb84Key) return;

    const rawKey = roomDetails.bb84Key;
    messages.forEach((msg) => {
      if (msg.isEncrypted && msg.iv && msg.text && !decryptedTexts[msg._id]) {
        void (async () => {
          try {
            const plain = await decryptTextMessage(msg.text, msg.iv!, rawKey);
            setDecryptedTexts((prev) => ({ ...prev, [msg._id]: plain }));
          } catch (err) {
            console.error(`Failed to decrypt message ${msg._id}:`, err);
            setDecryptedTexts((prev) => ({ ...prev, [msg._id]: '⚠️ [Decryption Failed: Key mismatch]' }));
          }
        })();
      }
    });
  }, [decryptedTexts, messages, roomDetails?.bb84Key]);

  useEffect(() => {
    if (!isResizingChat) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const handlePointerMove = (event: PointerEvent) => {
      setChatDrawerWidth(clampChatDrawerWidth(window.innerWidth - event.clientX));
    };
    const stopResizing = () => setIsResizingChat(false);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing, { once: true });

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };
  }, [isResizingChat]);

  const filteredRooms = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    return (rooms ?? []).filter((room) => {
      const otherUser = room.otherUser;
      const matchesSearch =
        !term ||
        otherUser?.fullName.toLowerCase().includes(term) ||
        otherUser?.school.toLowerCase().includes(term) ||
        room.preview.toLowerCase().includes(term);

      if (!matchesSearch) return false;
      if (selectedFilter === 'unread') return room.unread > 0;
      return true;
    });
  }, [rooms, searchQuery, selectedFilter]);

  const activeRoom = (rooms ?? []).find(room => room._id === activeRoomId) ?? null;
  const userName = currentUser?.fullName ?? 'Academic Member';
  const userRole = currentUser?.role === 'lecturer' ? 'Lecturer' : 'Student';

  const isConfirmedByMe = currentUser?._id
    ? (roomDetails?.bb84ConfirmedUsers?.includes(currentUser._id) ?? false)
    : false;
  const isConfirmedByOther = currentUser?._id
    ? (roomDetails?.bb84ConfirmedUsers?.some((id) => id !== currentUser._id) ?? false)
    : false;

  const handleSelectRoom = (roomId: Id<'chatRooms'>) => {
    const isNewRoom = roomId !== prevActiveRoomIdRef.current;
    prevActiveRoomIdRef.current = roomId;
    setActiveRoomId(roomId);
    setSearchParams({ roomId });
    // Always show fingerprint modal when navigating to a room from the rooms list
    if (isNewRoom) {
      // The fingerprint modal will be triggered by the useEffect that watches roomDetails
      // We reset confirmation check so the modal re-evaluates on next roomDetails load
      setShowKeyModal(false);
    }
  };

  const handleCloseDrawer = () => {
    prevActiveRoomIdRef.current = null;
    setActiveRoomId(null);
    setSearchParams({});
    setMenuMessage(null);
    setEditingId(null);
    setShowKeyModal(false);
  };

  const handleConfirmFingerprint = async () => {
    if (!sessionToken || !activeRoomId) return;
    try {
      await confirmBB84Key({ sessionToken, roomId: activeRoomId });
      setShowKeyModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm key.');
    }
  };

  const handleRegenerateKey = async () => {
    if (!sessionToken || !activeRoomId) return;
    setIsSimulatingBB84(true);
    try {
      await resetBB84KeyExchange({ sessionToken, roomId: activeRoomId });
      const result = await performBB84KeyExchange();
      // Update local full details for the debug view
      // Send only summary stats to Convex
      await initiateBB84KeyExchange({
        sessionToken,
        roomId: activeRoomId,
        bb84Key: result.sharedKeyHex,
        bb84Fingerprint: result.fingerprint,
        debugInfo: {
          totalBitsSent: result.details.totalBitsSent,
          siftedLength: result.details.siftedLength,
          efficiencyPercentage: result.details.efficiencyPercentage,
          qber: result.details.qber,
        },
      });
      setShowKeyModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not re-run key exchange.');
    } finally {
      setIsSimulatingBB84(false);
    }
  };

  const handleDownloadDecryptedFile = async (message: ChatMessage) => {
    if (!message.attachmentUrl || !message.iv || !roomDetails?.bb84Key) return;

    setDecryptingFileId(message._id);
    try {
      const response = await fetch(message.attachmentUrl);
      const encryptedBlob = await response.blob();

      const decryptedFile = await decryptFile(
        encryptedBlob,
        message.iv,
        roomDetails.bb84Key,
        message.attachmentName || 'decrypted-file',
        message.attachmentType || 'application/octet-stream'
      );

      const objectUrl = URL.createObjectURL(decryptedFile);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = decryptedFile.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error('Failed to decrypt attachment:', err);
      alert('Failed to decrypt attachment. Shared key mismatch or corrupted payload.');
    } finally {
      setDecryptingFileId(null);
    }
  };

  const startCoordsRef = useRef<{ x: number; y: number } | null>(null);

  // Long-press handlers for hold-to-act on own messages (hold for 2 to 3 seconds)
  const handlePointerDown = (event: React.PointerEvent, message: ChatMessage) => {
    // Mouse right-clicks are handled by onContextMenu below. Do not let the
    // long-press timer compete with the desktop context-menu interaction.
    if (!message.isMine || (event.pointerType === 'mouse' && event.button !== 0)) return;
    startCoordsRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = setTimeout(() => {
      setMenuMessage(message);
    }, 2000);
  };

  const handleMessageContextMenu = (event: React.MouseEvent, message: ChatMessage) => {
    if (!message.isMine) return;
    event.preventDefault();
    event.stopPropagation();
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    startCoordsRef.current = null;
    setMenuMessage(message);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!startCoordsRef.current || !longPressTimerRef.current) return;
    const dx = event.clientX - startCoordsRef.current.x;
    const dy = event.clientY - startCoordsRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      startCoordsRef.current = null;
    }
  };

  const handlePointerUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    startCoordsRef.current = null;
  };

  const handleDeleteMessage = async (messageToDelete = menuMessage) => {
    if (!messageToDelete || !sessionToken) return;
    const deletedMessageId = messageToDelete._id;
    setIsDeleting(true);
    try {
      await deleteMessage({ sessionToken, messageId: deletedMessageId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete message.');
    } finally {
      setIsDeleting(false);
      setMenuMessage(null);
    }
  };

  const handleStartEdit = (messageToEdit = menuMessage) => {
    if (!messageToEdit) return;
    setEditingId(messageToEdit._id);
    setEditText(decryptedTexts[messageToEdit._id] || messageToEdit.text);
    setMenuMessage(null);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !sessionToken) return;
    const editedMessageId = editingId;
    let messageTextToStore = editText;
    let ivToStore: string | undefined;
    let isEncrypted = false;

    if (roomDetails?.bb84Key) {
      const encrypted = await encryptTextMessage(editText, roomDetails.bb84Key);
      messageTextToStore = encrypted.ciphertext;
      ivToStore = encrypted.iv;
      isEncrypted = true;
    }

    setIsEditing(true);
    try {
      await editMessage({
        sessionToken,
        messageId: editedMessageId,
        text: messageTextToStore,
        ...(ivToStore ? { iv: ivToStore } : {}),
        isEncrypted,
      });

      if (isEncrypted) {
        setDecryptedTexts((prev) => ({ ...prev, [editedMessageId]: editText }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not edit message.');
    } finally {
      setIsEditing(false);
      setEditingId(null);
      setEditText('');
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleSelectedFile = (file: File | null) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('Attachments must be 10MB or smaller.');
      return;
    }
    setSelectedFile(file);
    setError('');
  };

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sessionToken || !activeRoomId || isSending) return;
    if (!newMessage.trim() && !selectedFile) return;

    if (!roomDetails?.bb84Key || !isConfirmedByMe) {
      setShowKeyModal(true);
      setError('Please confirm the BB84 Quantum Key fingerprint before sending messages.');
      return;
    }

    setIsSending(true);
    setError('');
    try {
      const rawKey = roomDetails.bb84Key;
      let textToSend = newMessage;
      let ivToSend: string | undefined;
      let isEncrypted = false;
      let attachmentUploadParams = {};

      // 1. AES-GCM Encrypt Text Payload with BB84 Shared Secret Key
      if (newMessage.trim()) {
        const encrypted = await encryptTextMessage(newMessage.trim(), rawKey);
        textToSend = encrypted.ciphertext;
        ivToSend = encrypted.iv;
        isEncrypted = true;
      }

      // 2. AES-GCM Encrypt Attachment File Blob
      if (selectedFile) {
        const encryptedFileResult = await encryptFile(selectedFile, rawKey);
        ivToSend = encryptedFileResult.iv;
        isEncrypted = true;

        const fileToUpload = new File([encryptedFileResult.encryptedBlob], selectedFile.name, {
          type: selectedFile.type,
        });

        attachmentUploadParams = await uploadAttachment(fileToUpload, generateUploadUrl);
      }

      // 3. Send Ciphertext and IV to Convex backend
      console.groupCollapsed(`📨 [Message] Sending hash message on the blockchain`);
      console.log(`   🏠 Room ID: ${activeRoomId}`);
      console.log(`   🔐 Encrypted: ${isEncrypted}`);
      console.log(`⛓️ Blockchain anchor: scheduled by Convex backend`);
      
      const result = await sendMessage({
        sessionToken,
        roomId: activeRoomId,
        text: textToSend,
        ...(ivToSend ? { iv: ivToSend } : {}),
        isEncrypted,
        ...attachmentUploadParams,
      });

      console.log(`✅ [Message] Message stored in Convex`);
      console.log(`   🆔 Message ID: ${result.messageId}`);
      console.log(`⛓️ [Blockchain] Message anchor is running asynchronously on Hyperledger Besu.`);
      console.groupEnd();

      // Cache decrypted text locally for smooth instant UI response
      if (newMessage.trim()) {
        setDecryptedTexts((prev) => ({ ...prev, [result.messageId]: newMessage.trim() }));
      }

      setNewMessage('');
      setSelectedFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send this message.');
    } finally {
      setIsSending(false);
    }
  };

  if (authLoading || (sessionToken && !currentUser)) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--surface)', color: 'var(--secondary)', fontWeight: 700 }}>
        Verifying secure academic credentials...
      </div>
    );
  }

  return (
    <div className="dashboard-layout" style={{ background: 'var(--surface)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppHeader userName={userName} userRole={userRole} />
      <Sidebar activeTab="messages" />

      <main className="app-main">
        <div className="app-main-inner">
          <div className="page-header">
            <div>
              <h1 className="page-title">Messages</h1>
            </div>
          </div>

          {error && (
            <div className="error-banner" style={{ background: '#fee2e2', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1rem', fontWeight: 600 }}>
              {error}
            </div>
          )}

          <div className="search-wrapper">
            <span className="material-symbols-outlined search-icon">search</span>
            <input
              type="text"
              placeholder="Search conversations, members, or universities..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="explore-clear-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>

          <div className="filters-bar">
            <button
              type="button"
              className={`filter-tag ${selectedFilter === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedFilter('all')}
            >
              All Messages
            </button>
            <button
              type="button"
              className={`filter-tag ${selectedFilter === 'unread' ? 'active' : ''}`}
              onClick={() => setSelectedFilter('unread')}
            >
              Unread
            </button>
          </div>

          <div className="conversations-list">
            {rooms === undefined ? (
              <div className="no-conversations">
                <span className="material-symbols-outlined no-conv-icon">hourglass_top</span>
                <p>Loading messages...</p>
              </div>
            ) : filteredRooms.length > 0 ? (
              filteredRooms.map((room) => {
                const isActive = room._id === activeRoomId;
                const read = room.unread === 0;
                const otherUser = room.otherUser;
                const name = otherUser?.fullName ?? 'Academic Peer';
                const initials = getInitials(name);

                return (
                  <div
                    key={room._id}
                    role="button"
                    tabIndex={0}
                    className={`conv-card ${isActive ? 'active-card' : ''} ${read ? 'read' : 'unread'}`}
                    onClick={() => handleSelectRoom(room._id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectRoom(room._id);
                      }
                    }}
                  >
                    <div className="conv-avatar-wrapper">
                      <div className="conv-avatar">
                        {otherUser?.avatarUrl ? (
                          <img src={otherUser.avatarUrl} alt={name} />
                        ) : (
                          <span className="conv-avatar-initials">{initials}</span>
                        )}
                      </div>
                      {otherUser?.isVerified && (
                        <span className="conv-verified-badge material-symbols-outlined" title="Verified University Identity">
                          verified
                        </span>
                      )}
                    </div>

                    <div className="conv-body">
                      <div className="conv-top-row">
                        <div className="conv-name-row">
                          <h3 className="conv-name">{name}</h3>
                          <span className={`conv-role-tag ${otherUser?.role === 'lecturer' ? 'lecturer-role' : 'student-role'}`}>
                            {otherUser?.role === 'lecturer' ? 'Lecturer' : 'Student'}
                          </span>
                          <span className={`conv-institution-tag ${otherUser?.role === 'lecturer' ? 'primary-tag' : 'secondary-tag'}`}>
                            {otherUser?.school ?? 'Academic Network'}
                          </span>
                        </div>
                        <span className={`conv-time ${read ? 'read-time' : 'unread-time'}`}>{formatTime(room.lastMessageAt)}</span>
                      </div>

                      <div className="conv-bottom-row">
                        {room.preview !== '🔒 Encrypted message' && !room.preview.startsWith('🔒 Encrypted ') && (
                          <p className={`conv-preview ${read ? 'read-preview' : 'unread-preview'}`}>{room.preview}</p>
                        )}
                        {room.unread > 0 && (
                          <div className="unread-badge">
                            <span>{room.unread}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="no-conversations">
                <span className="material-symbols-outlined no-conv-icon">chat_bubble_outline</span>
                <p>No conversations yet. Open Explore to find members and start a chat.</p>
              </div>
            )}
          </div>

          <div className="end-of-conversations">
            <p className="end-label">End of conversations</p>
            <div className="end-bar"></div>
          </div>
        </div>
      </main>

      <Footer />

      {activeRoom && activeRoom.otherUser && (
        <div className={`chat-drawer-overlay ${isResizingChat ? 'resizing-chat' : ''}`} onClick={handleCloseDrawer}>
          <div
            className="chat-drawer"
            style={{ '--chat-drawer-width': `${chatDrawerWidth}px` } as React.CSSProperties}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="chat-drawer-resize-handle"
              aria-label="Resize chat panel"
              title="Drag to resize chat"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsResizingChat(true);
              }}
            />
            <div className="chat-drawer-header">
              <button className="close-drawer-btn" onClick={handleCloseDrawer}>
                <span className="material-symbols-outlined">arrow_back</span>
              </button>
              <div className="chat-drawer-user-info">
                <div className="chat-drawer-avatar-wrapper">
                  <div className="chat-drawer-avatar">
                    {activeRoom.otherUser.avatarUrl ? (
                      <img src={activeRoom.otherUser.avatarUrl} alt={activeRoom.otherUser.fullName} />
                    ) : (
                      <span className="conv-avatar-initials">{getInitials(activeRoom.otherUser.fullName)}</span>
                    )}
                  </div>
                  {activeRoom.otherUser.isVerified && (
                    <span className="chat-drawer-verified-badge material-symbols-outlined">verified</span>
                  )}
                </div>
                <div>
                  <h3 className="chat-drawer-name">{activeRoom.otherUser.fullName}</h3>
                  <div className="chat-drawer-meta">
                    <span className={`chat-drawer-role ${activeRoom.otherUser.role === 'lecturer' ? 'lecturer-role' : 'student-role'}`}>
                      {activeRoom.otherUser.role === 'lecturer' ? 'Lecturer' : 'Student'}
                    </span>
                    <p className="chat-drawer-school">{activeRoom.otherUser.school}</p>
                  </div>
                </div>
              </div>

              {/* BB84 Quantum Key Fingerprint Badge in Drawer Header */}
              {roomDetails?.bb84Fingerprint && (
                <button
                  className={`chat-bb84-key-badge ${isConfirmedByMe ? 'confirmed' : 'pending'}`}
                  onClick={() => setShowKeyModal(true)}
                  title="View BB84 Quantum Key Fingerprint"
                >
                  <span className="key-icon">⚛️</span>
                  <span className="key-label">SHARED KEY FINGERPRINT</span>
                  <span className="key-fp">{roomDetails.bb84Fingerprint}</span>
                  <span className="key-status">{isConfirmedByMe ? '✓' : '⚠️ Confirm'}</span>
                </button>
              )}
            </div>

            <div className="chat-drawer-messages">
              {messages === undefined ? (
                <div className="no-conversations">
                  <span className="material-symbols-outlined no-conv-icon">hourglass_top</span>
                  <p>Loading messages...</p>
                </div>
              ) : messages.length > 0 ? (
                messages.map((message) => {
                  const isEncrypted = message.isEncrypted;
                  const decryptedText = isEncrypted
                    ? (decryptedTexts[message._id] || 'Tap to decrypt message...')
                    : message.text;

                  return (
                    <div
                      key={message._id}
                      className={`message-bubble-wrapper ${message.isMine ? 'outgoing' : 'incoming'}`}
                      onPointerDown={(e) => handlePointerDown(e, message)}
                      onPointerUp={handlePointerUp}
                      onPointerLeave={handlePointerUp}
                      onPointerCancel={handlePointerUp}
                      onPointerMove={handlePointerMove}
                      onContextMenu={(e) => handleMessageContextMenu(e, message)}
                      style={{ userSelect: 'none' }}
                    >
                      <div className={`message-bubble ${editingId === message._id ? 'editing' : ''}`}>
                        {message.isMine && editingId !== message._id && (
                          <div className="message-hover-actions" aria-label="Message actions">
                            {!message.attachmentUrl && (
                              <button
                                type="button"
                                className="message-hover-action edit"
                                aria-label="Edit message"
                                title="Edit message"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleStartEdit(message);
                                }}
                              >
                                <span className="material-symbols-outlined">edit</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="message-hover-action delete"
                              aria-label="Delete message"
                              title="Delete message"
                              disabled={isDeleting}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDeleteMessage(message);
                              }}
                            >
                              <span className="material-symbols-outlined">delete</span>
                            </button>
                          </div>
                        )}
                        {editingId === message._id ? (
                          <div className="message-edit-area">
                            <input
                              ref={editInputRef}
                              className="message-edit-input"
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveEdit();
                                if (e.key === 'Escape') handleCancelEdit();
                              }}
                            />
                            <div className="message-edit-actions">
                              <button type="button" className="msg-action-cancel" onClick={handleCancelEdit}>
                                <span className="material-symbols-outlined">close</span>
                              </button>
                              <button type="button" className="msg-action-save" onClick={() => void handleSaveEdit()} disabled={isEditing || !editText.trim()}>
                                <span className="material-symbols-outlined">{isEditing ? 'hourglass_top' : 'check'}</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {decryptedText && <p className="message-text">{decryptedText}</p>}
                            
                            {/* Attachment handling */}
                            {message.attachmentUrl && (
                              isEncrypted ? (
                                <div className="encrypted-attachment-box" style={{ margin: '0.4rem 0' }}>
                                  <button
                                    className="msg-action-cancel"
                                    onClick={() => void handleDownloadDecryptedFile(message)}
                                    disabled={decryptingFileId === message._id}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.4rem',
                                      padding: '0.4rem 0.8rem',
                                      borderRadius: '6px',
                                      background: '#0284c7',
                                      color: '#ffffff',
                                      border: 'none',
                                      cursor: 'pointer',
                                      fontSize: '0.82rem',
                                      fontWeight: 600,
                                    }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>
                                      {decryptingFileId === message._id ? 'hourglass_top' : 'lock_open'}
                                    </span>
                                    {decryptingFileId === message._id ? 'Decrypting File...' : `Decrypt & Save ${message.attachmentName || 'Attachment'}`}
                                  </button>
                                </div>
                              ) : (
                                <AttachmentLink attachment={message} compact />
                              )
                            )}

                            <span className="message-time" style={{ display: 'inline-flex', alignItems: 'center' }}>
                              {message.editedAt ? 'edited · ' : ''}{formatTime(message.createdAt)}
                              {message.blockchainTxHash ? (
                                <span 
                                  className="material-symbols-outlined onchain-tick" 
                                  style={{ 
                                    fontSize: '0.85rem', 
                                    color: '#00c853',
                                    marginLeft: '0.25rem', 
                                    cursor: 'help'
                                  }}
                                  title={`Anchored on Hyperledger Besu Blockchain. Tx: ${message.blockchainTxHash}`}
                                >
                                  link
                                </span>
                              ) : (
                                <span 
                                  className="material-symbols-outlined onchain-tick" 
                                  style={{ 
                                    fontSize: '0.85rem', 
                                    color: 'var(--outline)', 
                                    marginLeft: '0.25rem'
                                  }}
                                  title="Saved to Convex, anchoring to Besu..."
                                >
                                  check
                                </span>
                              )}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="no-conversations">
                  <span className="material-symbols-outlined no-conv-icon">forum</span>
                  <p>No messages yet. Send the first one.</p>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {!isConfirmedByMe && (
              <div className="key-unconfirmed-warning" style={{ background: '#fffbe3', borderTop: '1px solid #fde68a', padding: '0.5rem 1rem', fontSize: '0.8rem', color: '#92400e', textAlign: 'center', fontWeight: 600 }}>
                ⚠️ Confirm the BB84 Fingerprint to enable sending messages.
                <button
                  onClick={() => setShowKeyModal(true)}
                  style={{ marginLeft: '0.5rem', textDecoration: 'underline', background: 'none', border: 'none', color: '#0284c7', cursor: 'pointer', fontWeight: 700 }}
                >
                  View Fingerprint
                </button>
              </div>
            )}

            <form onSubmit={(event) => void handleSendMessage(event)} className="chat-drawer-input-area">
              <AttachmentPicker selectedFile={selectedFile} onFileChange={handleSelectedFile} onClear={() => setSelectedFile(null)} />
              <input
                type="text"
                placeholder={isConfirmedByMe ? "Type your message..." : "Confirm BB84 fingerprint to chat..."}
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                className="chat-drawer-input"
                disabled={!isConfirmedByMe}
              />
              <button type="submit" className="chat-drawer-send-btn" disabled={isSending || !isConfirmedByMe || (!newMessage.trim() && !selectedFile)}>
                <span className="material-symbols-outlined">{isSending ? 'hourglass_top' : 'send'}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ===== BB84 KEY CONFIRMATION & EDUCATIONAL MODAL ===== */}
      {showKeyModal && roomDetails?.bb84Fingerprint && (
        <BB84KeyModal
          fingerprint={roomDetails.bb84Fingerprint}
          isConfirmedByMe={isConfirmedByMe}
          isConfirmedByOther={isConfirmedByOther}
          otherUserName={activeRoom?.otherUser?.fullName || 'Academic Peer'}
          onConfirm={() => void handleConfirmFingerprint()}
          onRegenerateKey={() => void handleRegenerateKey()}
          onClose={() => setShowKeyModal(false)}
        />
      )}

      {/* ===== MESSAGE CONTEXT MENU ===== */}
      {menuMessage && (
        <>
          <button
            type="button"
            className="msg-menu-backdrop"
            aria-label="Close menu"
            onClick={() => setMenuMessage(null)}
          />
          <div className="msg-context-menu" role="menu">
            <div className="msg-context-preview">
              <span className="material-symbols-outlined" style={{ fontSize: '1rem', opacity: 0.5 }}>
                {menuMessage.attachmentUrl ? 'attach_file' : 'chat_bubble'}
              </span>
              <span className="msg-context-preview-text">
                {menuMessage.attachmentName || decryptedTexts[menuMessage._id] || menuMessage.text || 'Message'}
              </span>
            </div>
            {!menuMessage.attachmentUrl && (
              <button
                type="button"
                className="msg-context-btn edit"
                role="menuitem"
                onClick={() => handleStartEdit()}
              >
                <span className="material-symbols-outlined">edit</span>
                Edit message
              </button>
            )}
            <button
              type="button"
              className="msg-context-btn delete"
              role="menuitem"
              onClick={() => void handleDeleteMessage()}
              disabled={isDeleting}
            >
              <span className="material-symbols-outlined">delete</span>
              {isDeleting ? 'Deleting…' : 'Delete message'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default MessagesList;
