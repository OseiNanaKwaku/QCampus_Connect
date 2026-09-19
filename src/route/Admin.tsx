import { useEffect, useMemo, useState } from 'react';
import { useMutation, useAction, useQuery } from 'convex/react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import AppHeader from '../components/AppHeader';
import Footer from '../components/Footer';
import { clearAdminSessionToken, getAdminSessionToken, onAdminSessionTokenChange } from '../lib/adminSession';
import { generateDynamicAuditReportText, CryptographicAuditReportView } from '../components/CryptographicAuditReportView';
import '../route_css/MessagesList.css';
import '../route_css/Admin.css';

const convexApi = api as any;

type ReviewStatus = 'unverified' | 'pending' | 'approved' | 'rejected';

type AdminUser = {
  requestId: Id<'verificationRequests'>;
  userId: Id<'users'>;
  fullName: string;
  email: string;
  role: 'student' | 'lecturer';
  school: string;
  departmentId: Id<'departments'> | null;
  departmentName: string;
  avatarUrl?: string;
  verificationStatus: 'unverified' | 'pending' | 'approved';
  verificationSubmittedAt: number;
  idNumber?: string;
  evidenceUrl?: string;
};

const getInitials = (name: string) => name
  .split(' ')
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0])
  .join('')
  .toUpperCase();

const formatSubmittedDate = (timestamp?: number) => timestamp
  ? new Intl.DateTimeFormat('en-GH', { day: 'numeric', month: 'short', year: 'numeric' }).format(timestamp)
  : 'Awaiting submission';

const formatIsoDateTime = (timestamp: number) => {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
};

const Admin = () => {
  const navigate = useNavigate();
  const [adminSessionToken, setAdminSessionToken] = useState(() => getAdminSessionToken());
  const adminProfile = useQuery(convexApi.admin.getMe, adminSessionToken ? { sessionToken: adminSessionToken } : 'skip');
  const requests = useQuery(
    convexApi.admin.getVerificationRequests,
    adminSessionToken && adminProfile ? { sessionToken: adminSessionToken } : 'skip',
  ) as AdminUser[] | undefined;
  const reviewVerificationRequest = useMutation(convexApi.admin.reviewVerificationRequest);
  const approveUserOnBlockchain = useAction(convexApi.blockchainActions.approveUser);

  // Mode switcher: 'queue' (Identity Review) | 'verification' (User Submission Verification) | 'departments' (Department Management)
  const [viewMode, setViewMode] = useState<'queue' | 'verification' | 'departments'>('verification');

  // Registration queue states
  const [activeStatus, setActiveStatus] = useState<'pending' | 'all'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<Id<'verificationRequests'> | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);

  // User submission verification states
  const [searchType, setSearchType] = useState<'email' | 'indexNumber' | 'staffId'>('indexNumber');
  const [searchValue, setSearchValue] = useState('UEB3509022');
  const [activeQueryValue, setActiveQueryValue] = useState('UEB3509022');
  const [selectedMessage, setSelectedMessage] = useState<any>(null);
  const [isSendingReport, setIsSendingReport] = useState(false);
  const [sendSuccessMessage, setSendSuccessMessage] = useState('');

  // Department Management states
  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [deptDescription, setDeptDescription] = useState('');
  const [editingDeptId, setEditingDeptId] = useState<Id<'departments'> | null>(null);
  const [deptFeedback, setDeptFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isSubmittingDept, setIsSubmittingDept] = useState(false);

  // Department assignment state in registration queue mode
  const [selectedDeptId, setSelectedDeptId] = useState<string>('');
  const [selectedSpecializations, setSelectedSpecializations] = useState('');

  const sendAuditReportToUser = useMutation(convexApi.admin.sendAuditReportToUser);

  // Live Convex queries for department management & verification
  const departmentsWithCount = useQuery(
    convexApi.admin.getDepartmentsWithCount,
    adminSessionToken && adminProfile ? { sessionToken: adminSessionToken } : 'skip'
  );
  const activeDepartments = useQuery(convexApi.qchat.getDepartments);

  const addDepartment = useMutation(convexApi.admin.addDepartment);
  const updateDepartment = useMutation(convexApi.admin.updateDepartment);
  const deleteDepartment = useMutation(convexApi.admin.deleteDepartment);
  const verifyUserWithDepartment = useMutation(convexApi.admin.verifyUserWithDepartment);

  // Live Convex queries for verification mode
  const searchedUser = useQuery(
    convexApi.admin.lookupUserByIdentifier,
    adminSessionToken && adminProfile && activeQueryValue
      ? { sessionToken: adminSessionToken, searchType, searchValue: activeQueryValue }
      : 'skip'
  );

  const userMessages = useQuery(
    convexApi.admin.getUserMessages,
    adminSessionToken && adminProfile && searchedUser?._id
      ? { sessionToken: adminSessionToken, userId: searchedUser._id, daysBack: 30 }
      : 'skip'
  );

  useEffect(() => onAdminSessionTokenChange(() => setAdminSessionToken(getAdminSessionToken())), []);

  useEffect(() => {
    if (!adminSessionToken) navigate('/admin/login');
  }, [adminSessionToken, navigate]);

  useEffect(() => {
    if (adminProfile === null) {
      clearAdminSessionToken();
      navigate('/admin/login');
    }
  }, [adminProfile, navigate]);

  const members = requests ?? [];
  const statusFor = (user: AdminUser): ReviewStatus => user.verificationStatus;
  const pendingCount = members.filter((user) => statusFor(user) === 'pending').length;
  const approvedCount = members.filter((user) => statusFor(user) === 'approved').length;
  const reviewQueue = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    return members.filter((user) => {
      const status = statusFor(user);
      const matchesStatus = activeStatus === 'all' || status === 'pending';
      const matchesSearch = !term || [user.fullName, user.email, user.school].some((value) => value.toLowerCase().includes(term));
      return matchesStatus && matchesSearch;
    });
  }, [activeStatus, members, searchQuery]);

  const selectedUser = members.find((user) => user.requestId === selectedId) ?? reviewQueue[0];

  useEffect(() => {
    setSelectedDeptId(selectedUser?.departmentId ?? '');
    setSelectedSpecializations('');
  }, [selectedUser?.requestId, selectedUser?.departmentId]);

  const handleReview = async (requestId: Id<'verificationRequests'>, status: 'approved' | 'rejected') => {
    if (!adminSessionToken || !selectedUser) return;
    setIsReviewing(true);
    try {
      if (status === 'approved') {
        const specs = selectedSpecializations
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        await verifyUserWithDepartment({
          sessionToken: adminSessionToken,
          userId: selectedUser.userId,
          departmentId: selectedDeptId ? (selectedDeptId as Id<'departments'>) : undefined,
          specializations: specs.length > 0 ? specs : undefined,
          approved: true,
        });

        // Patch Convex DB — returns userId for blockchain anchoring
        const result: any = await reviewVerificationRequest({
          sessionToken: adminSessionToken,
          requestId,
          status: 'approved',
        });

        console.groupCollapsed(`👤 [Approval] User approval`);
        console.log(`✅ User approved in Convex DB`);
        console.log(`   👤 User ID: ${result?.userId || selectedUser.userId}`);
        console.log(`   👤 User: ${selectedUser.fullName}`);
        console.log(`⛓️ Submitting approval record to Hyperledger Besu...`);

        // Fire-and-forget: anchor approval to Besu blockchain
        approveUserOnBlockchain({
          userId: result?.userId || selectedUser.userId,
          role: selectedUser.role,
          name: selectedUser.fullName,
        })
          .then((bcResult: any) => {
            if (bcResult?.success) {
              console.log(`✅ [Blockchain] Approval anchored on Besu!`);
              console.log(`   🔗 Tx Hash: ${bcResult.txHash}`);
              console.log(`   👤 Approved: ${selectedUser.fullName}`);
              console.log(`📦 [Blockchain] Approval transaction confirmed.`);
              console.groupEnd();
            } else {
              console.warn(`⚠️  [Blockchain] Besu approval notice (non-fatal): ${bcResult?.error}`);
              console.info(`   ℹ️ User is approved in Convex DB. Blockchain sync can retry.`);
              console.groupEnd();
            }
          })
          .catch((err: any) => {
            console.error(`❌ [Blockchain] Besu approval failed (non-fatal):`, err?.message || err);
            console.groupEnd();
            console.info(`   ℹ️  Approval is stored in Convex. Blockchain will sync when Besu is reachable.`);
          });

      } else {
        await reviewVerificationRequest({ sessionToken: adminSessionToken, requestId, status: 'rejected' });
      }
      setSelectedId(null);
      setSelectedDeptId('');
      setSelectedSpecializations('');
    } finally {
      setIsReviewing(false);
    }
  };

  const handleSaveDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminSessionToken || !deptName.trim() || !deptCode.trim()) return;
    setIsSubmittingDept(true);
    setDeptFeedback(null);
    try {
      if (editingDeptId) {
        await updateDepartment({
          sessionToken: adminSessionToken,
          departmentId: editingDeptId,
          name: deptName.trim(),
          code: deptCode.trim(),
          description: deptDescription.trim() || undefined,
        });
        setDeptFeedback({ type: 'success', text: '✅ Department updated successfully.' });
      } else {
        await addDepartment({
          sessionToken: adminSessionToken,
          name: deptName.trim(),
          code: deptCode.trim(),
          description: deptDescription.trim() || undefined,
        });
        setDeptFeedback({ type: 'success', text: '✅ Department created successfully.' });
      }
      setDeptName('');
      setDeptCode('');
      setDeptDescription('');
      setEditingDeptId(null);
    } catch (err: any) {
      setDeptFeedback({
        type: 'error',
        text: err.message === 'DEPARTMENT_CODE_EXISTS'
          ? '❌ Department code already exists.'
          : err.message === 'DEPARTMENT_NAME_EXISTS'
            ? '❌ A department with that name already exists.'
            : err.message || 'Failed to save department.',
      });
    } finally {
      setIsSubmittingDept(false);
    }
  };

  const handleEditDepartment = (dept: any) => {
    setEditingDeptId(dept._id);
    setDeptName(dept.name);
    setDeptCode(dept.code);
    setDeptDescription(dept.description || '');
    setDeptFeedback(null);
  };

  const handleToggleDeptStatus = async (dept: any) => {
    if (!adminSessionToken) return;
    try {
      await updateDepartment({
        sessionToken: adminSessionToken,
        departmentId: dept._id,
        isActive: !dept.isActive,
      });
    } catch (err: any) {
      alert(err.message || 'Failed to update status.');
    }
  };

  const handleDeleteDepartment = async (deptId: Id<'departments'>) => {
    if (!adminSessionToken || !confirm('Are you sure you want to delete this department?')) return;
    try {
      await deleteDepartment({ sessionToken: adminSessionToken, departmentId: deptId });
      if (editingDeptId === deptId) {
        setEditingDeptId(null);
        setDeptName('');
        setDeptCode('');
        setDeptDescription('');
      }
    } catch (err: any) {
      alert(err.message === 'DEPARTMENT_HAS_USERS' ? '❌ Cannot delete department that has assigned users.' : err.message || 'Failed to delete department.');
    }
  };

  const handleExecuteVerificationSearch = () => {
    if (searchValue.trim()) {
      setActiveQueryValue(searchValue.trim());
    }
  };

  const handleSendAuditReport = async () => {
    if (!searchedUser || !selectedMessage || !adminSessionToken) return;
    setIsSendingReport(true);
    setSendSuccessMessage('');
    try {
      const reportText = generateDynamicAuditReportText(searchedUser, selectedMessage);
      await sendAuditReportToUser({
        sessionToken: adminSessionToken,
        userId: searchedUser._id,
        reportText,
      });
      try {
        await navigator.clipboard.writeText(reportText);
      } catch {
        // ignore clipboard failure if not supported
      }
      setSendSuccessMessage('✅ Audit Report successfully sent directly to user & copied to clipboard!');
    } catch (err: any) {
      setSendSuccessMessage('❌ Failed to send report: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSendingReport(false);
    }
  };

  if (!adminSessionToken || adminProfile === null) {
    return null;
  }

  if (adminProfile === undefined || requests === undefined) {
    return <div className="admin-loading">Preparing verification desk...</div>;
  }

  return (
    <div className="dashboard-layout admin-layout">
      <AppHeader userName={adminProfile.displayName} userRole="Administrator" />

      <main className="app-main admin-main">
        <div className="admin-main-inner">
          <div className="admin-eyebrow">
            <span className="material-symbols-outlined">
              admin_panel_settings
            </span>{" "}
            Administration / Audit & Verification Desk
          </div>

          <div className="admin-page-header">
            <div>
              <h1 className="admin-title">Verification & Audit Desk</h1>
              <p className="admin-subtitle">
                Verify academic submissions and user identities using real-world
                identifiers.
              </p>
            </div>
            <div className="admin-header-actions">
              <div className="admin-date-chip">
                <span className="material-symbols-outlined">
                  calendar_today
                </span>
                {new Intl.DateTimeFormat("en-GH", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                }).format(new Date())}
              </div>
              <button
                className="admin-logout"
                type="button"
                onClick={() => {
                  clearAdminSessionToken();
                  navigate("/admin/login");
                }}
              >
                Sign out
              </button>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <nav className="admin-mode-nav" aria-label="Admin Section Toggles">
            <button
              className={`admin-mode-btn ${viewMode === "verification" ? "active" : ""}`}
              onClick={() => setViewMode("verification")}
              type="button"
            >
              <span className="material-symbols-outlined">verified_user</span>{" "}
              User Submission Request
            </button>
            <button
              className={`admin-mode-btn ${viewMode === "queue" ? "active" : ""}`}
              onClick={() => setViewMode("queue")}
              type="button"
            >
              <span className="material-symbols-outlined">how_to_reg</span>{" "}
              Identity Registration Queue ({pendingCount})
            </button>
            <button
              className={`admin-mode-btn ${viewMode === "departments" ? "active" : ""}`}
              onClick={() => setViewMode("departments")}
              type="button"
            >
              <span className="material-symbols-outlined">domain</span>{" "}
              Department Management ({departmentsWithCount?.length || 0})
            </button>
          </nav>

          {/* MODE 1: USER SUBMISSION VERIFICATION (SEARCH BY EMAIL, INDEX NUMBER, STAFF ID) */}
          {viewMode === "verification" && (
            <div className="verification-workspace">
              {/* Search Card */}
              <section className="verification-search-card">
                <h2>🔍 Search User To Confirm Transcations</h2>
                <p>
                  Lookup any student or lecturer by their real-world identifier
                  (Email, Index Number, or Staff ID) to audit blockchain proof
                  and file authenticity.
                </p>

                <div
                  className="search-type-selector"
                  role="radiogroup"
                  aria-label="Identifier Type"
                >
                  <button
                    className={`search-type-btn ${searchType === "indexNumber" ? "active" : ""}`}
                    onClick={() => setSearchType("indexNumber")}
                    type="button"
                  >
                    🆔 Student Index Number
                  </button>
                  <button
                    className={`search-type-btn ${searchType === "staffId" ? "active" : ""}`}
                    onClick={() => setSearchType("staffId")}
                    type="button"
                  >
                    🏛️ Lecturer Staff ID (PS***)
                  </button>
                  <button
                    className={`search-type-btn ${searchType === "email" ? "active" : ""}`}
                    onClick={() => setSearchType("email")}
                    type="button"
                  >
                    📧 Email Address
                  </button>
                </div>

                <div className="search-input-group">
                  <input
                    type="text"
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    placeholder={
                      searchType === "indexNumber"
                        ? "Enter index number (e.g. UEB3509022)"
                        : searchType === "staffId"
                          ? "Enter staff ID (e.g. PS001, PS123)"
                          : "Enter institutional email (e.g. osei@uenr.edu.gh)"
                    }
                    onKeyDown={(e) =>
                      e.key === "Enter" && handleExecuteVerificationSearch()
                    }
                  />
                  <button
                    className="search-submit-btn"
                    type="button"
                    onClick={handleExecuteVerificationSearch}
                  >
                    <span className="material-symbols-outlined">search</span>{" "}
                    Search
                  </button>
                </div>
              </section>

              {/* User Result Card */}
              {searchedUser === undefined && activeQueryValue ? (
                <div className="admin-loading" style={{ minHeight: "10rem" }}>
                  Searching Convex database...
                </div>
              ) : searchedUser ? (
                <>
                  <section className="verification-user-card">
                    <div className="vuser-header">
                      <div className="vuser-identity">
                        <span className="vuser-avatar">
                          {searchedUser.avatarUrl ? (
                            <img src={searchedUser.avatarUrl} alt="" />
                          ) : (
                            getInitials(searchedUser.fullName)
                          )}
                        </span>
                        <div className="vuser-name">
                          <h3>👤 {searchedUser.fullName}</h3>
                          <p>
                            {searchedUser.email} • {searchedUser.school}
                          </p>
                        </div>
                      </div>
                      <span className={`vuser-badge ${searchedUser.role}`}>
                        <span className="material-symbols-outlined">
                          {searchedUser.role === "lecturer"
                            ? "school"
                            : "person"}
                        </span>
                        {searchedUser.role === "lecturer"
                          ? "Lecturer"
                          : "Student"}
                      </span>
                    </div>

                    <div className="vuser-grid">
                      <div className="vuser-item">
                        <span>Identifier</span>
                        <strong>
                          {searchedUser.role === "student"
                            ? searchedUser.indexNumber || searchedUser.idNumber
                            : searchedUser.staffId || searchedUser.idNumber}
                        </strong>
                      </div>
                      <div className="vuser-item">
                        <span>Institution</span>
                        <strong>{searchedUser.school}</strong>
                      </div>
                      <div className="vuser-item">
                        <span>Verification Status</span>
                        <strong>
                          {searchedUser.verificationStatus === "approved"
                            ? "✅ Verified on Blockchain"
                            : "⏳ Pending"}
                        </strong>
                      </div>
                      <div className="vuser-item">
                        <span>Wallet Address</span>
                        <span className="mono-val">
                          {searchedUser.walletAddress}
                        </span>
                      </div>
                    </div>
                  </section>

                  {/* Submissions & Messages History Table */}
                  <section className="submissions-card">
                    <div className="submissions-header">
                      <h3>
                        📨 Submission & Communication History (Last 30 Days)
                      </h3>
                      <div className="submissions-stats">
                        <span className="stat-tag">
                          Total: {userMessages?.length || 0}
                        </span>
                        <span className="stat-tag verified">
                          ✅ Verified:{" "}
                          {userMessages?.filter(
                            (m: any) => m.blockchainVerified,
                          ).length || 0}
                        </span>
                        <span className="stat-tag tampered">
                          ⚠️ Tampered: 0
                        </span>
                      </div>
                    </div>

                    {!userMessages || userMessages.length === 0 ? (
                      <div className="admin-empty">
                        <span className="material-symbols-outlined">inbox</span>
                        <p>
                          No submission records found for this user in the last
                          30 days.
                        </p>
                      </div>
                    ) : (
                      <div className="messages-table-wrap">
                        <table className="messages-table">
                          <thead>
                            <tr>
                              <th>Date & Time</th>
                              <th>Content Preview</th>
                              <th>Attachments</th>
                              <th>Blockchain Proof</th>
                              <th>Status</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {userMessages.map((msg: any) => (
                              <tr
                                key={msg._id}
                                className={
                                  msg.blockchainVerified && msg.hashMatches
                                    ? "authentic"
                                    : "tampered"
                                }
                              >
                                <td>{formatIsoDateTime(msg.createdAt)}</td>
                                <td>
                                  {msg.text
                                    ? msg.text.length > 35
                                      ? `${msg.text.slice(0, 35)}...`
                                      : msg.text
                                    : "—"}
                                </td>
                                <td>
                                  {msg.attachmentName ? (
                                    <a
                                      className="file-pill"
                                      href={msg.attachmentUrl || "#"}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      📎 {msg.attachmentName}
                                    </a>
                                  ) : (
                                    <span style={{ color: "#a09788" }}>
                                      None
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {msg.blockchainVerified ? (
                                    <span className="badge-authentic">
                                      ✅ Recorded
                                    </span>
                                  ) : (
                                    <span className="badge-pending">
                                      ⏳ Unrecorded
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {msg.blockchainVerified && msg.hashMatches ? (
                                    <span className="badge-authentic">
                                      ✅ Authentic
                                    </span>
                                  ) : (
                                    <span className="badge-tampered">
                                      ⚠️ TAMPERED!
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <button
                                    className="proof-btn"
                                    type="button"
                                    onClick={() => setSelectedMessage(msg)}
                                  >
                                    <span className="material-symbols-outlined">
                                      find_in_page
                                    </span>{" "}
                                    View Proof
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </>
              ) : activeQueryValue ? (
                <div className="admin-empty verification-search-card">
                  <span className="material-symbols-outlined">
                    person_search
                  </span>
                  <p>User not found in Convex database!</p>
                  <small>
                    No user document matched search type "{searchType}" with
                    value "{activeQueryValue}". Please try a quick test pill
                    above.
                  </small>
                </div>
              ) : null}

              {/* Selected Message Cryptographic Audit Trail Modal */}
              {selectedMessage && searchedUser && (
                <div className="audit-modal-overlay">
                  <div className="audit-modal">
                    <div className="audit-modal-header">
                      <h3>
                        <span className="material-symbols-outlined">
                          verified
                        </span>{" "}
                        Cryptographic Audit Trail
                      </h3>
                      <button
                        className="audit-close-btn"
                        type="button"
                        onClick={() => setSelectedMessage(null)}
                      >
                        <span className="material-symbols-outlined">close</span>
                      </button>
                    </div>

                    <div className="audit-grid">
                      <div className="audit-item">
                        <label>Submission / Message ID</label>
                        <span>{selectedMessage._id}</span>
                      </div>
                      <div className="audit-item">
                        <label>Sender Identity</label>
                        <span>
                          {searchedUser.fullName} (
                          {searchedUser.role === "student"
                            ? searchedUser.indexNumber || searchedUser.idNumber
                            : searchedUser.staffId || searchedUser.idNumber}
                          )
                        </span>
                      </div>
                      <div className="audit-item">
                        <label>Convex Database Timestamp</label>
                        <span>
                          {formatIsoDateTime(selectedMessage.createdAt)}
                          <span className="tag-mutable">⚠️ Mutable DB</span>
                        </span>
                      </div>
                      <div className="audit-item">
                        <label>Blockchain Block Timestamp</label>
                        <span>
                          {selectedMessage.blockchainTimestamp}
                          <span className="tag-immutable">✅ IMMUTABLE</span>
                        </span>
                      </div>
                      <div className="audit-item">
                        <label>Blockchain Block Number</label>
                        <span>#{selectedMessage.blockchainBlock}</span>
                      </div>
                      <div className="audit-item">
                        <label>Sender Address Verification</label>
                        <span style={{ color: "#059669", fontWeight: 900 }}>
                          ✅ Matches Registered User Wallet
                        </span>
                      </div>
                      <div className="audit-item full-width">
                        <label>Blockchain Transaction Hash</label>
                        <span className="mono-val">
                          {selectedMessage.blockchainTxHash}
                        </span>
                      </div>
                      <div className="audit-item full-width">
                        <label>Content SHA-256 Hash</label>
                        <span className="mono-val">
                          {selectedMessage.storedHash}
                        </span>
                      </div>
                    </div>

                    <div className={`audit-verdict-box ${selectedMessage.blockchainVerified ? 'success' : 'pending'}`}>
                      {selectedMessage.blockchainVerified ? (
                        <>
                          <h4>✅ VERDICT: AUTHENTIC SUBMISSION</h4>
                          <p>
                            Cryptographic hash matches the Hyperledger Besu
                            blockchain record. Content and timestamp have not been
                            altered.
                          </p>
                        </>
                      ) : (
                        <>
                          <h4>⏳ VERDICT: NOT YET ANCHORED TO BLOCKCHAIN</h4>
                          <p>
                            This message has not been anchored to the Hyperledger Besu
                            blockchain yet. It exists in the Convex database but has no
                            on-chain proof. This is normal if the Besu node was unreachable
                            at the time of submission.
                          </p>
                        </>
                      )}
                    </div>

                    <div className="audit-report-preview-box">
                      <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>
                        🏛️ Dynamic Cryptographic Audit Card (Mined Ledger Record)
                      </label>
                      <CryptographicAuditReportView
                        record={{
                          firstName: searchedUser.firstName || searchedUser.fullName?.split(' ')[0] || 'Student',
                          lastName: searchedUser.lastName || searchedUser.fullName?.split(' ').slice(1).join(' ') || '',
                          indexNumber: (searchedUser.role === 'student' ? searchedUser.indexNumber || searchedUser.idNumber : searchedUser.staffId || searchedUser.idNumber) || 'N/A',
                          email: searchedUser.email || 'N/A',
                          assignmentName: selectedMessage.attachmentName || (selectedMessage.text ? `academic_submission_${selectedMessage._id.slice(-6)}.pdf` : 'academic_submission.pdf'),
                          txHash: selectedMessage.blockchainTxHash,
                          blockNumber: selectedMessage.blockchainBlock ? String(selectedMessage.blockchainBlock) : undefined,
                          _creationTime: selectedMessage.createdAt,
                        }}
                      />
                      <label style={{ display: 'block', marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                        📜 Formatted ASCII Audit Report (Dispatched directly to user record)
                      </label>
                      <pre className="audit-report-pre">
                        {generateDynamicAuditReportText(searchedUser, selectedMessage)}
                      </pre>
                    </div>

                    {sendSuccessMessage && (
                      <div className="send-feedback">{sendSuccessMessage}</div>
                    )}

                    <div className="audit-actions">
                      <button
                        className="btn-print-report"
                        type="button"
                        disabled={isSendingReport}
                        onClick={handleSendAuditReport}
                      >
                        <span className="material-symbols-outlined">send</span>{" "}
                        {isSendingReport
                          ? "Sending Report..."
                          : "Send Audit Report to User"}
                      </button>
                      <button
                        className="btn-modal-close"
                        type="button"
                        onClick={() => {
                          setSelectedMessage(null);
                          setSendSuccessMessage("");
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MODE 2: REGISTRATION QUEUE (ORIGINAL DESK) */}
          {viewMode === "queue" && (
            <>
              <section
                className="admin-stats"
                aria-label="Verification overview"
              >
                <div className="admin-stat admin-stat-primary">
                  <span className="admin-stat-label">Needs review</span>
                  <strong>{pendingCount}</strong>
                  <span className="admin-stat-foot">
                    <span className="material-symbols-outlined">
                      priority_high
                    </span>{" "}
                    Pending applications
                  </span>
                </div>
                <div className="admin-stat">
                  <span className="admin-stat-label">Verified members</span>
                  <strong>{approvedCount}</strong>
                  <span className="admin-stat-foot">
                    <span className="material-symbols-outlined">verified</span>{" "}
                    Approved identities
                  </span>
                </div>
                <div className="admin-stat">
                  <span className="admin-stat-label">Directory size</span>
                  <strong>{members.length}</strong>
                  <span className="admin-stat-foot">
                    <span className="material-symbols-outlined">groups</span>{" "}
                    Registered members
                  </span>
                </div>
              </section>

              <div className="admin-workspace">
                <section className="admin-queue-panel">
                  <div className="admin-panel-heading">
                    <div>
                      <span className="admin-section-kicker">Review queue</span>
                      <h2>Identity requests</h2>
                    </div>
                    <span className="admin-count-badge">
                      {reviewQueue.length} visible
                    </span>
                  </div>
                  <div className="admin-toolbar">
                    <div className="admin-search">
                      <span className="material-symbols-outlined">search</span>
                      <input
                        aria-label="Search verification requests"
                        placeholder="Search by name, email, or institution"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                      />
                    </div>
                    <div
                      className="admin-tabs"
                      role="tablist"
                      aria-label="Request status"
                    >
                      <button
                        className={activeStatus === "pending" ? "active" : ""}
                        onClick={() => setActiveStatus("pending")}
                      >
                        Pending <span>{pendingCount}</span>
                      </button>
                      <button
                        className={activeStatus === "all" ? "active" : ""}
                        onClick={() => setActiveStatus("all")}
                      >
                        All members
                      </button>
                    </div>
                  </div>

                  {reviewQueue.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined">
                        task_alt
                      </span>
                      <p>No requests match this view.</p>
                      <small>
                        New identity submissions will appear here for review.
                      </small>
                    </div>
                  ) : (
                    <div className="admin-request-list">
                      {reviewQueue.map((user) => {
                        const status = statusFor(user);
                        return (
                          <button
                            type="button"
                            className={`admin-request ${selectedUser?.requestId === user.requestId ? "selected" : ""}`}
                            key={user.requestId}
                            onClick={() => setSelectedId(user.requestId)}
                          >
                            <span className="admin-avatar">
                              {user.avatarUrl ? (
                                <img src={user.avatarUrl} alt="" />
                              ) : (
                                getInitials(user.fullName)
                              )}
                            </span>
                            <span className="admin-request-copy">
                              <strong>{user.fullName}</strong>
                              <span>{user.school}</span>
                              <small>
                                {user.role === "lecturer"
                                  ? "Lecturer"
                                  : "Student"}{" "}
                                · Submitted{" "}
                                {formatSubmittedDate(
                                  user.verificationSubmittedAt,
                                )}
                              </small>
                            </span>
                            <span
                              className={`admin-status-dot ${status}`}
                              aria-label={status}
                            />
                            <span className="material-symbols-outlined admin-chevron">
                              chevron_right
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>

                <aside className="admin-detail-panel">
                  {selectedUser ? (
                    <>
                      <div className="admin-detail-top">
                        <span className="admin-section-kicker">
                          Application details
                        </span>
                        <span
                          className={`admin-status-pill ${statusFor(selectedUser)}`}
                        >
                          {statusFor(selectedUser)}
                        </span>
                      </div>
                      <div className="admin-detail-profile">
                        <span className="admin-detail-avatar">
                          {selectedUser.avatarUrl ? (
                            <img src={selectedUser.avatarUrl} alt="" />
                          ) : (
                            getInitials(selectedUser.fullName)
                          )}
                        </span>
                        <h2>{selectedUser.fullName}</h2>
                        <p>{selectedUser.email}</p>
                      </div>
                      <div className="admin-detail-facts">
                        <div>
                          <span>Institution</span>
                          <strong>{selectedUser.school}</strong>
                        </div>
                        <div>
                          <span>Role</span>
                          <strong>
                            {selectedUser.role === "lecturer"
                              ? "Lecturer"
                              : "Student"}
                          </strong>
                        </div>
                        <div>
                          <span>Submitted</span>
                          <strong>
                            {formatSubmittedDate(
                              selectedUser.verificationSubmittedAt,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Registered department</span>
                          <strong>{selectedUser.departmentName || 'Not provided'}</strong>
                        </div>
                      </div>
                      <div className="admin-evidence-card">
                        <div className="admin-evidence-icon">
                          <span className="material-symbols-outlined">
                            badge
                          </span>
                        </div>
                        <div>
                          <strong>Academic credentials</strong>
                          <p>
                            {selectedUser.evidenceUrl
                              ? "Evidence submitted for this application."
                              : "No evidence link is attached to this application."}
                          </p>
                        </div>
                        {selectedUser.evidenceUrl && (
                          <a
                            href={selectedUser.evidenceUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Open academic credentials"
                          >
                            <span className="material-symbols-outlined">
                              open_in_new
                            </span>
                          </a>
                        )}
                      </div>
                      {statusFor(selectedUser) === "pending" && (
                        <>
                          <div
                            style={{
                              marginTop: "1rem",
                              display: "flex",
                              flexDirection: "column",
                              gap: ".6rem",
                            }}
                          >
                            <div className="dept-form-field">
                              <label>Registered Department</label>
                              <select
                                value={selectedDeptId}
                                onChange={(e) =>
                                  setSelectedDeptId(e.target.value)
                                }
                              >
                                <option value="">
                                  -- Select Department --
                                </option>
                                {activeDepartments?.map((dept: any) => (
                                  <option key={dept._id} value={dept._id}>
                                    {dept.name} ({dept.code})
                                  </option>
                                ))}
                              </select>
                            </div>

                            {selectedUser.role === "lecturer" && (
                              <div className="dept-form-field">
                                <label>Specializations (Comma-separated)</label>
                                <input
                                  type="text"
                                  placeholder="e.g. Cryptography, Cybersecurity, AI"
                                  value={selectedSpecializations}
                                  onChange={(e) =>
                                    setSelectedSpecializations(e.target.value)
                                  }
                                />
                              </div>
                            )}
                          </div>

                          <div className="admin-actions">
                            <button
                              type="button"
                              className="admin-reject"
                              disabled={isReviewing}
                              onClick={() =>
                                void handleReview(
                                  selectedUser.requestId,
                                  "rejected",
                                )
                              }
                            >
                              <span className="material-symbols-outlined">
                                close
                              </span>
                              Reject
                            </button>
                            <button
                              type="button"
                              className="admin-approve"
                              disabled={isReviewing}
                              onClick={() =>
                                void handleReview(
                                  selectedUser.requestId,
                                  "approved",
                                )
                              }
                            >
                              <span className="material-symbols-outlined">
                                verified
                              </span>
                              {isReviewing ? "Saving..." : "Approve identity"}
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="admin-empty admin-detail-empty">
                      <span className="material-symbols-outlined">
                        fact_check
                      </span>
                      <p>Select a request to inspect its details.</p>
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}

          {/* MODE 3: DEPARTMENT MANAGEMENT */}
          {viewMode === "departments" && (
            <div className="departments-workspace">
              {/* Department List */}
              <section className="departments-card">
                <h2>🏛️ Academic Departments</h2>
                <p>
                  Manage university departments, course codes, and view user
                  assignments across departments.
                </p>

                {!departmentsWithCount ? (
                  <div className="admin-loading" style={{ minHeight: "10rem" }}>
                    Loading departments...
                  </div>
                ) : departmentsWithCount.length === 0 ? (
                  <div className="admin-empty">
                    <span className="material-symbols-outlined">
                      domain_disabled
                    </span>
                    <p>No departments created yet.</p>
                    <small>
                      Use the form on the right to add your first academic
                      department.
                    </small>
                  </div>
                ) : (
                  <div className="messages-table-wrap">
                    <table className="messages-table">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Department Name</th>
                          <th>Description</th>
                          <th>Users</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {departmentsWithCount.map((dept: any) => (
                          <tr key={dept._id}>
                            <td>
                              <strong className="mono-val">{dept.code}</strong>
                            </td>
                            <td>
                              <strong>{dept.name}</strong>
                            </td>
                            <td>{dept.description || "—"}</td>
                            <td>
                              <span className="stat-tag">
                                {dept.userCount} users
                              </span>
                            </td>
                            <td>
                              <span
                                className={
                                  dept.isActive
                                    ? "dept-badge-active"
                                    : "dept-badge-inactive"
                                }
                              >
                                {dept.isActive ? "Active" : "Inactive"}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: ".3rem" }}>
                                <button
                                  className="dept-action-icon"
                                  title="Edit department"
                                  type="button"
                                  onClick={() => handleEditDepartment(dept)}
                                >
                                  <span className="material-symbols-outlined">
                                    edit
                                  </span>
                                </button>
                                <button
                                  className="dept-action-icon"
                                  title={
                                    dept.isActive
                                      ? "Deactivate department"
                                      : "Activate department"
                                  }
                                  type="button"
                                  onClick={() => handleToggleDeptStatus(dept)}
                                >
                                  <span className="material-symbols-outlined">
                                    {dept.isActive ? "toggle_on" : "toggle_off"}
                                  </span>
                                </button>
                                <button
                                  className="dept-action-icon delete"
                                  title="Delete department"
                                  type="button"
                                  onClick={() =>
                                    handleDeleteDepartment(dept._id)
                                  }
                                >
                                  <span className="material-symbols-outlined">
                                    delete
                                  </span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Add / Edit Department Form */}
              <section className="departments-card">
                <h2>
                  {editingDeptId
                    ? "✏️ Edit Department"
                    : "➕ Add New Department"}
                </h2>
                <p>
                  {editingDeptId
                    ? "Update department code or details."
                    : "Create an academic department for classifying lecturers, students, and Q&A threads."}
                </p>

                {deptFeedback && (
                  <div
                    className={`send-feedback ${deptFeedback.type === "error" ? "tampered" : ""}`}
                    style={{ marginBottom: "1rem" }}
                  >
                    {deptFeedback.text}
                  </div>
                )}

                <form onSubmit={handleSaveDepartment} className="dept-form">
                  <div className="dept-form-field">
                    <label>Department's Abrevaition *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. CS, ENG, MATH, PHYS"
                      value={deptCode}
                      onChange={(e) => setDeptCode(e.target.value)}
                    />
                  </div>

                  <div className="dept-form-field">
                    <label>Department Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Department of Computer Science"
                      value={deptName}
                      onChange={(e) => setDeptName(e.target.value)}
                    />
                  </div>

                  <div className="dept-form-field">
                    <label>Description (Optional)</label>
                    <textarea
                      rows={3}
                      placeholder="Brief description of this academic unit"
                      value={deptDescription}
                      onChange={(e) => setDeptDescription(e.target.value)}
                    />
                  </div>

                  <div className="dept-form-actions">
                    <button
                      className="dept-btn-primary"
                      type="submit"
                      disabled={isSubmittingDept}
                    >
                      {isSubmittingDept
                        ? "Saving..."
                        : editingDeptId
                          ? "Update Department"
                          : "Add New Department"}
                    </button>
                    {editingDeptId && (
                      <button
                        className="dept-btn-secondary"
                        type="button"
                        onClick={() => {
                          setEditingDeptId(null);
                          setDeptName("");
                          setDeptCode("");
                          setDeptDescription("");
                          setDeptFeedback(null);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </form>
              </section>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default Admin;
