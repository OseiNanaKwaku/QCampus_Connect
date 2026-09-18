import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect, useState, Component, ErrorInfo, ReactNode } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { generateClientIdentityKeys } from "./services/web3Service";
import { getPrivateKeyFromIndexedDB } from "./utils/cryptoBridge";
import { getSessionToken, clearSessionToken } from "./lib/session";

import LandingPage from "./route/LandingPage";
import Login from "./route/Login";
import Register from "./route/Register";
import ForgotPassword from "./route/ForgotPassword";
import MessagesList from "./route/MessagesList";
import QAPage from "./route/QAPage";
import Explore from "./route/Explore";
import VerifyProfile from "./route/VerifyProfile";
import EditProfile from "./route/EditProfile";
import Admin from "./route/Admin";
import AdminLogin from "./route/AdminLogin";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class GatekeeperErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn("[GatekeeperErrorBoundary] Intercepted crash, auto-clearing stale tokens:", error, errorInfo);
    try {
      clearSessionToken();
      localStorage.removeItem("qchat_active_user_id");
      localStorage.removeItem("qchat_session_token");
      sessionStorage.clear();
    } catch {
      // Ignore storage flush errors
    }
  }

  private handleReset = () => {
    try {
      clearSessionToken();
      localStorage.removeItem("qchat_active_user_id");
      localStorage.removeItem("qchat_session_token");
      sessionStorage.clear();
    } catch {
      // Ignore storage flush errors
    }
    window.location.href = "/login";
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "var(--surface, #121212)",
          color: "var(--text-primary, #ffffff)",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "system-ui, -apple-system, sans-serif"
        }}>
          <div style={{
            background: "rgba(255, 255, 255, 0.05)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: "12px",
            padding: "2rem",
            maxWidth: "480px",
            width: "100%"
          }}>
            <h2 style={{ fontSize: "1.25rem", marginBottom: "0.75rem", color: "#e07a5f" }}>
              Authentication State Re-synchronized
            </h2>
            <p style={{ fontSize: "0.9rem", color: "#a0a0a0", marginBottom: "1.5rem", lineHeight: 1.5 }}>
              Your session was safely reset after a network or storage update. Stale cached authentication tokens have been flushed automatically.
            </p>
            <button
              onClick={this.handleReset}
              style={{
                background: "var(--primary, #3a5f94)",
                color: "#ffffff",
                border: "none",
                borderRadius: "8px",
                padding: "0.75rem 1.5rem",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: "0.95rem"
              }}
            >
              Continue to Sign In
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const [activeUserId, setActiveUserId] = useState<string | null>(
    () => localStorage.getItem("qchat_active_user_id")
  );

  const sessionToken = getSessionToken();
  const me = useQuery(api.users.getMe, sessionToken ? { sessionToken } : "skip");

  useEffect(() => {
    if (me?._id) {
      localStorage.setItem("qchat_active_user_id", me._id);
      setActiveUserId(me._id);
    } else if (!sessionToken || me === null) {
      // If sessionToken is missing or confirmed invalid by server, flush stale cache
      localStorage.removeItem("qchat_active_user_id");
      localStorage.removeItem("qchat_session_token");
      sessionStorage.clear();
      setActiveUserId(null);
    }
  }, [me, sessionToken]);

  return (
    <GatekeeperErrorBoundary>
      <BrowserRouter>
        {/* Background worker – only runs when a user is logged in */}
        {activeUserId && (
          <CryptographicLoginGatekeeper
            currentUserId={activeUserId as Id<"users">}
            onResetSession={() => setActiveUserId(null)}
          />
        )}

        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/messages" element={<MessagesList />} />
          <Route path="/qa" element={<QAPage />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/verify-profile" element={<VerifyProfile />} />
          <Route path="/edit-profile" element={<EditProfile />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/login" element={<AdminLogin />} />
        </Routes>
      </BrowserRouter>
    </GatekeeperErrorBoundary>
  );
}

export function CryptographicLoginGatekeeper({
  currentUserId,
  onResetSession,
}: {
  currentUserId: Id<"users"> | string;
  onResetSession?: () => void;
}) {
  const userProfile = useQuery(api.users.getById, { id: currentUserId as any });
  const updateProfileKeys = useMutation(api.users.updateProfileKeys);

  useEffect(() => {
    // Convex queries return undefined while loading, and null if no document was found
    if (userProfile === null) {
      console.warn("[Gatekeeper] User ID not found in database. Automatically purging stale browser session...");
      try {
        clearSessionToken();
        localStorage.removeItem("qchat_active_user_id");
        localStorage.removeItem("qchat_session_token");
        sessionStorage.clear();
      } catch {
        // Ignore storage errors
      }
      if (onResetSession) {
        onResetSession();
      } else if (window.location.pathname !== "/login" && window.location.pathname !== "/register" && window.location.pathname !== "/") {
        window.location.replace("/login");
      }
    }
  }, [userProfile, onResetSession]);

  useEffect(() => {
    async function enforceIdentityKeys() {
      if (!userProfile) return;

      try {
        const existingKey = await getPrivateKeyFromIndexedDB(userProfile._id);

        if (!existingKey || !userProfile.hasKeypair) {
          console.log(
            `%c[Crypto Guard] Initializing secure key generation for: ${userProfile.fullName}`,
            "color: #3b82f6; font-weight: bold;"
          );

          const exportedPublicKeyString = await generateClientIdentityKeys(userProfile._id);

          await updateProfileKeys({
            id: userProfile._id,
            publicKey: exportedPublicKeyString,
            hasKeypair: true,
          });

          console.log(
            `%c[Crypto Guard] Success! Identity keys established for ${userProfile.fullName} and saved to IndexedDB & DB.`,
            "color: #10b981; font-weight: bold;"
          );
        }
      } catch (err) {
        console.error("Cryptographic registration process stalled:", err);
      }
    }

    enforceIdentityKeys();
  }, [userProfile, updateProfileKeys]);

  return null; // Operates completely in the background
}

export default App;
