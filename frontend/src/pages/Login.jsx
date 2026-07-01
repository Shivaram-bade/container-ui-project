import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../services/authService';
import '../styles/Login.css';

const serviceContainers = [
  'AUTH', 'API', 'NGINX', 'POSTGRES', 'MYSQL', 'REDIS', 'WORKER',
  'QUEUE', 'AI', 'SEARCH', 'CACHE', 'GATEWAY', 'PAYMENTS', 'METRICS',
];

const deploymentSteps = [
  ['Starting container...', 'AUTH', '78%'],
  ['Pulling image...', 'API', '46%'],
  ['Creating network...', 'GATEWAY', '64%'],
  ['Initializing service...', 'METRICS', '92%'],
];

const crashEvents = [
  'OOMKilled',
  'Container exited with code 137',
  'Restarting...',
  'Memory limit exceeded',
  'CrashLoopBackOff',
  'Health check failed',
];

const observabilityMetrics = [
  ['CPU', '72%', 'metric-cpu'],
  ['RAM', '84%', 'metric-ram'],
  ['PODS', '148', 'metric-pods'],
  ['RPS', '18.4k', 'metric-rps'],
  ['LATENCY', '42ms', 'metric-latency'],
  ['RESTARTS', '7', 'metric-alert'],
];

const shipManifests = [
  { id: 'bluefin', className: 'ship-primary', labels: ['AUTH', 'API', 'POSTGRES', 'REDIS', 'NGINX'] },
  { id: 'sentinel', className: 'ship-secondary', labels: ['WORKER', 'QUEUE', 'AI', 'SEARCH'] },
];

const LOGIN_REVEAL_DELAY_MS = 3000;
const DRONE_MOVE_MS = 2600;
const DRONE_STAGGER_MS = 450;
const DRONE_TARGET_HOLD_MS = 950;
const DRONE_QUEUE_WAIT_MS = 900;
const DRONE_RETURN_SETTLE_MS = 500;
const DRONE_RECALL_ITEMS = [
  { key: 'readiness', selector: '.drone-a', className: 'drone-a', label: 'Readiness', offset: -86 },
  { key: 'liveness', selector: '.drone-b', className: 'drone-b', label: 'Liveness', offset: 0 },
  { key: 'startup', selector: '.drone-c', className: 'drone-c', label: 'Startup', offset: 86 },
];

function InfrastructureScene({ droneSequence }) {
  return (
    <div className="infra-scene" aria-hidden="true">
      <div className="sky-layer" />
      <div className="parallax-depth depth-back">
        <DatacenterSkyline />
        <TopologyHologram />
        <TelemetryPanels />
      </div>
      <div className="parallax-depth depth-mid">
        <KubernetesCranes />
        <ContainerYard />
        <DeploymentConveyors />
        <OOMFailures />
      </div>
      <div className="parallax-depth depth-front">
        <CargoShips />
        <RecoveryDrones sequence={droneSequence} />
      </div>
      <Ocean />
      <RainLayer />
      <Fog />
      <SparkField />
      <DroneRecallOverlay sequence={droneSequence} />
      <div className="scene-focus" />
      <div className="scene-vignette" />
    </div>
  );
}

function DatacenterSkyline() {
  return (
    <div className="datacenter-skyline">
      {Array.from({ length: 20 }).map((_, index) => (
        <span className={`dc-tower dc-tower-${index % 7}`} key={index}>
          <i />
          <i />
          <i />
        </span>
      ))}
      <div className="cloud-core">
        <span />
        <span />
        <span />
        <strong>CONTROL PLANE</strong>
      </div>
    </div>
  );
}

function TopologyHologram() {
  return (
    <div className="topology-hologram">
      {Array.from({ length: 8 }).map((_, index) => <span className={`topology-node node-${index}`} key={index} />)}
      <i className="traffic-beam beam-one" />
      <i className="traffic-beam beam-two" />
      <i className="traffic-beam beam-three" />
      <strong>service mesh</strong>
    </div>
  );
}

function TelemetryPanels() {
  return (
    <div className="telemetry-layer">
      <div className="deployment-feed">
        {deploymentSteps.map(([status, service, progress], index) => (
          <div className="deployment-line" key={service} style={{ '--delay': `${index * -0.8}s` }}>
            <span>{status}</span>
            <strong>{service}</strong>
            <i><b style={{ width: progress }} /></i>
          </div>
        ))}
      </div>

      <div className="metrics-grid">
        {observabilityMetrics.map(([label, value, className], index) => (
          <div className={`metric-card ${className}`} key={label} style={{ '--delay': `${index * -0.55}s` }}>
            <span>{label}</span>
            <strong>{value}</strong>
            <i />
          </div>
        ))}
      </div>

      <div className="scaling-panel">
        <span>Pod scaling</span>
        <strong>{'12 -> 18 replicas'}</strong>
        <div>
          {Array.from({ length: 18 }).map((_, index) => <i key={index} className={index > 11 ? 'new-pod' : ''} />)}
        </div>
      </div>
    </div>
  );
}

function KubernetesCranes() {
  return (
    <div className="kube-cranes">
      <Crane className="crane-alpha" service="GATEWAY" />
      <Crane className="crane-beta" service="PAYMENTS" />
      <Crane className="crane-gamma" service="METRICS" />
    </div>
  );
}

function Crane({ className, service }) {
  return (
    <div className={`orchestration-crane ${className}`}>
      <div className="crane-column" />
      <div className="crane-arm" />
      <div className="crane-trolley" />
      <div className="crane-cable" />
      <div className="deploy-container">
        <span>{service}</span>
        <i />
      </div>
    </div>
  );
}

function ContainerYard() {
  return (
    <div className="service-yard">
      {serviceContainers.map((service, index) => {
        const state = index % 7 === 0 ? 'deploying' : index % 5 === 0 ? 'warming' : 'healthy';
        return (
          <div className={`service-container ${state} service-${index}`} key={service}>
            <span>{service}</span>
            <i />
          </div>
        );
      })}
    </div>
  );
}

function DeploymentConveyors() {
  return (
    <div className="conveyor-system">
      <div className="conveyor-belt belt-one">
        <span>API</span>
        <span>QUEUE</span>
        <span>SEARCH</span>
      </div>
      <div className="conveyor-belt belt-two">
        <span>NGINX</span>
        <span>CACHE</span>
        <span>METRICS</span>
      </div>
    </div>
  );
}

function OOMFailures() {
  return (
    <div className="oom-zone">
      <div className="emergency-light" />
      <div className="damaged-stack">
        <div className="damaged-container damaged-one">WORKER</div>
        <div className="damaged-container damaged-two">AI</div>
        <div className="damaged-container damaged-three">QUEUE</div>
      </div>
      <div className="fire-effect" />
      <div className="smoke-particle smoke-a" />
      <div className="smoke-particle smoke-b" />
      <div className="smoke-particle smoke-c" />
      <div className="electric-spark spark-a" />
      <div className="electric-spark spark-b" />
      <div className="electric-spark spark-c" />
      <div className="error-holograms">
        {crashEvents.map((event, index) => (
          <span key={event} className={`error-line error-${index}`}>{event}</span>
        ))}
      </div>
    </div>
  );
}

function CargoShips() {
  return (
    <div className="cargo-lane">
      {shipManifests.map((ship) => <CargoShip key={ship.id} {...ship} />)}
    </div>
  );
}

function CargoShip({ className, labels }) {
  return (
    <div className={`cargo-ship ${className}`}>
      <div className="ship-bridge"><span /><span /></div>
      <div className="ship-load">
        {labels.map((label, index) => <span className={`ship-container load-${index}`} key={`${label}-${index}`}>{label}</span>)}
      </div>
      <div className="ship-hull" />
      <div className="ship-wake" />
    </div>
  );
}

function RecoveryDrones({ sequence }) {
  const recallClass = sequence?.active ? ' drone-recall-muted' : '';

  return (
    <div className={`recovery-drones${recallClass}`}>
      <div className="repair-drone drone-a"><strong>Readiness</strong><span /></div>
      <div className="repair-drone drone-b"><strong>Liveness</strong><span /></div>
      <div className="repair-drone drone-c"><strong>Startup</strong><span /></div>
      <div className="ai-monitor">
        <span>AI recovery</span>
        <strong>self-healing active</strong>
      </div>
    </div>
  );
}

function DroneRecallOverlay({ sequence }) {
  if (!sequence?.active || !sequence?.positions) {
    return null;
  }

  return (
    <div className="drone-recall-overlay" key={sequence.id} aria-hidden="true">
      {DRONE_RECALL_ITEMS.map((drone) => {
        const position = sequence.positions[drone.key] || sequence.starts?.[drone.key] || { x: 0, y: 0, scale: 1 };
        return (
          <div
            className={`repair-drone ${drone.className}`}
            key={drone.key}
            style={{
              '--drone-x': `${position.x}px`,
              '--drone-y': `${position.y}px`,
              '--drone-scale': position.scale ?? 1,
            }}
          >
            <strong>{drone.label}</strong>
            <span />
          </div>
        );
      })}
    </div>
  );
}

function Ocean() {
  return (
    <div className="ocean">
      <div className="water-deep" />
      <div className="water-grid" />
      <div className="water-reflection reflection-a" />
      <div className="water-reflection reflection-b" />
      <div className="wet-dock" />
    </div>
  );
}

function RainLayer() {
  return (
    <div className="rain-layer">
      {Array.from({ length: 36 }).map((_, index) => <span key={index} style={{ '--rain-index': index }} />)}
    </div>
  );
}

function Fog() {
  return (
    <>
      <div className="fog fog-back" />
      <div className="fog fog-front" />
    </>
  );
}

function SparkField() {
  return (
    <div className="spark-field">
      {Array.from({ length: 28 }).map((_, index) => <span key={index} className={`spark-${index % 7}`} />)}
    </div>
  );
}

function PasswordVisibilityIcon({ visible }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.7a2 2 0 002.7 2.7" />
      <path d="M9.9 4.2A10.8 10.8 0 0112 4c5.5 0 9 5.5 9 5.5a16.8 16.8 0 01-2.1 2.7" />
      <path d="M6.6 6.7C4.3 8.2 3 10.5 3 10.5S6.5 16 12 16a9.8 9.8 0 003.1-.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12s3.5-5.5 9-5.5S21 12 21 12s-3.5 5.5-9 5.5S3 12 3 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const droneRecallRunRef = useRef(0);
  const droneRecallTimerRef = useRef([]);
  const droneSequenceRef = useRef(null);
  const [showLoginCard, setShowLoginCard] = useState(false);
  const [droneSequence, setDroneSequence] = useState({ active: false, id: 0, starts: null, positions: null, targets: [], returning: false });
  const [authMode, setAuthMode] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const isLogin = authMode === 'login';
  const isRegister = authMode === 'register';
  const isForgotPassword = authMode === 'forgot';

  const clearDroneRecallTimers = () => {
    droneRecallTimerRef.current.forEach((timerId) => window.clearTimeout(timerId));
    droneRecallTimerRef.current = [];
  };

  const waitForDroneRecall = (duration, runId) => new Promise((resolve) => {
    const timerId = window.setTimeout(() => {
      droneRecallTimerRef.current = droneRecallTimerRef.current.filter((id) => id !== timerId);
      resolve();
    }, duration);
    droneRecallTimerRef.current.push(timerId);
  });

  const getLinePositions = (target) => DRONE_RECALL_ITEMS.reduce((positions, drone) => {
    positions[drone.key] = {
      x: target.x + drone.offset - 21,
      y: target.y - 9,
      scale: 1,
    };
    return positions;
  }, {});

  const getCapturedDronePositions = () => DRONE_RECALL_ITEMS.reduce((positions, drone) => {
    const activeNode = document.querySelector(`.drone-recall-overlay ${drone.selector}`);
    const sceneNode = document.querySelector(`.recovery-drones ${drone.selector}`);
    const rect = (activeNode || sceneNode)?.getBoundingClientRect();
    positions[drone.key] = rect ? { x: rect.left, y: rect.top, scale: 1 } : { x: 0, y: 0, scale: 1 };
    return positions;
  }, {});

  const runDroneRecallQueue = async (runId) => {
    await waitForDroneRecall(50, runId);
    let targetIndex = 0;

    while (droneRecallRunRef.current === runId) {
      let latest = droneSequenceRef.current;
      if (!latest?.active) {
        return;
      }

      if (targetIndex >= latest.targets.length) {
        if (latest.targets.length < 3) {
          await waitForDroneRecall(DRONE_QUEUE_WAIT_MS, runId);
          latest = droneSequenceRef.current;
          if (targetIndex < latest.targets.length) {
            continue;
          }
        }
        break;
      }

      const target = latest.targets[targetIndex];
      setDroneSequence((current) => (
        current.id === runId
          ? (() => {
              const next = { ...current, positions: getLinePositions(target), returning: false };
              droneSequenceRef.current = next;
              return next;
            })()
          : current
      ));
      await waitForDroneRecall(DRONE_MOVE_MS + (DRONE_STAGGER_MS * 2) + DRONE_TARGET_HOLD_MS, runId);
      targetIndex += 1;
    }

    const latest = droneSequenceRef.current;
    if (droneRecallRunRef.current !== runId || !latest?.active) {
      return;
    }

    setDroneSequence((current) => (
      current.id === runId
        ? (() => {
            const next = { ...current, positions: current.starts, returning: true };
            droneSequenceRef.current = next;
            return next;
          })()
        : current
    ));
    await waitForDroneRecall(DRONE_MOVE_MS + (DRONE_STAGGER_MS * 2) + DRONE_RETURN_SETTLE_MS, runId);

    if (droneRecallRunRef.current === runId) {
      setDroneSequence((current) => (
        current.id === runId
          ? (() => {
              const next = { ...current, active: false, starts: null, positions: null, targets: [], returning: false };
              droneSequenceRef.current = next;
              return next;
            })()
          : current
      ));
    }
  };

  useEffect(() => {
    const revealTimer = window.setTimeout(() => {
      setShowLoginCard(true);
    }, LOGIN_REVEAL_DELAY_MS);

    return () => {
      window.clearTimeout(revealTimer);
      clearDroneRecallTimers();
    };
  }, []);

  useEffect(() => {
    droneSequenceRef.current = droneSequence;
  }, [droneSequence]);

  const handleLoginPageClick = (event) => {
    if (event.target.closest('.login-card')) {
      return;
    }

    const targetX = Math.max(130, Math.min(window.innerWidth - 130, event.clientX));
    const targetY = Math.max(90, Math.min(window.innerHeight - 150, event.clientY));
    const target = { x: targetX, y: targetY };
    const latest = droneSequenceRef.current;

    if (latest?.active && !latest.returning) {
      if (latest.targets.length >= 3) {
        return;
      }
      setDroneSequence((current) => (
        current.active && current.id === latest.id && current.targets.length < 3
          ? (() => {
              const next = { ...current, targets: [...current.targets, target] };
              droneSequenceRef.current = next;
              return next;
            })()
          : current
      ));
      return;
    }

    clearDroneRecallTimers();
    const runId = droneRecallRunRef.current + 1;
    droneRecallRunRef.current = runId;
    const starts = getCapturedDronePositions();
    const nextSequence = { active: true, id: runId, starts, positions: starts, targets: [target], returning: false };
    droneSequenceRef.current = nextSequence;
    setDroneSequence(nextSequence);
    runDroneRecallQueue(runId);
  };

  const getErrorMessage = (err) => {
    const data = err.response?.data;

    if (!data) {
      return err.message || 'An error occurred. Please try again.';
    }

    if (typeof data === 'string') {
      return data;
    }

    if (data.detail || data.error) {
      return data.detail || data.error;
    }

    const fieldErrors = Object.entries(data)
      .map(([field, messages]) => {
        const message = Array.isArray(messages) ? messages.join(' ') : messages;
        return `${field}: ${message}`;
      })
      .join(' ');

    return fieldErrors || 'An error occurred. Please try again.';
  };

  const switchMode = (nextMode) => {
    setAuthMode(nextMode);
    setPasswordVisible(false);
    setConfirmPasswordVisible(false);
    setError('');
    setSuccess('');
    setPassword('');
    setConfirmPassword('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (isLogin) {
        if (!username || !password) {
          setError('Please enter your username and password');
          setLoading(false);
          return;
        }

        const response = await authService.login(username, password);
        localStorage.setItem('access_token', response.data.access_token);
        localStorage.setItem('refresh_token', response.data.refresh_token);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        setSuccess('Login successful. Redirecting to your dashboard...');
        setTimeout(() => {
          sessionStorage.setItem('vitel-login-entrance', 'pending');
          sessionStorage.setItem('vitel-environment-selector', 'pending');
          sessionStorage.removeItem('vitel-selected-environment');
          navigate('/home', { replace: true });
        }, 800);
      } else if (isRegister) {
        if (!username || !email || !password || !confirmPassword) {
          setError('Please complete all registration fields');
          setLoading(false);
          return;
        }

        if (password !== confirmPassword) {
          setError('Passwords do not match');
          setLoading(false);
          return;
        }

        const response = await authService.register(username, email, password);
        setSuccess(response.data.message || 'Account created. Please sign in.');
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setTimeout(() => {
          setAuthMode('login');
          setSuccess('');
        }, 1500);
      } else {
        if (!username || !password || !confirmPassword) {
          setError('Please enter your username, new password, and confirm password');
          setLoading(false);
          return;
        }

        if (password !== confirmPassword) {
          setError('New password and confirm password do not match');
          setLoading(false);
          return;
        }

        if (password.length < 8) {
          setError('New password must be at least 8 characters');
          setLoading(false);
          return;
        }

        const response = await authService.forgotPassword({
          username,
          new_password: password,
          confirm_password: confirmPassword,
        });
        setSuccess(response.data.message || 'Password updated successfully. Please sign in.');
        setPassword('');
        setConfirmPassword('');
        setTimeout(() => {
          setAuthMode('login');
          setSuccess('');
        }, 1500);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-container" onClick={handleLoginPageClick}>
      <InfrastructureScene droneSequence={droneSequence} />

      {!showLoginCard && (
        <p className="login-splash-status" role="status" aria-live="polite">
          Loading Container UI
        </p>
      )}

      {showLoginCard && (
      <section className="login-card" aria-label="Container UI authentication">
        <div className="login-card-glow" />
        <div className="login-brand">
          <span className="logo-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <p>Container UI App</p>
            <h1 className="login-title">{isForgotPassword ? 'Reset password' : isLogin ? 'Welcome back' : 'Create account'}</h1>
            <span className="login-subtitle">
              {isForgotPassword
                ? 'Enter your username and choose a new password to return to the login page.'
                : isLogin
                  ? 'Sign in with your username and password to manage containers, deployments, and agents.'
                  : 'Create an account to access the container and Kubernetes command center.'}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="tab-buttons" role="tablist" aria-label="Authentication mode">
            <button type="button" className={`tab-btn ${isLogin ? 'active' : ''}`} onClick={() => switchMode('login')} aria-selected={isLogin} role="tab">
              Sign in
            </button>
            <button type="button" className={`tab-btn ${isRegister ? 'active' : ''}`} onClick={() => switchMode('register')} aria-selected={isRegister} role="tab">
              Create account
            </button>
            <button type="button" className={`tab-btn ${isForgotPassword ? 'active' : ''}`} onClick={() => switchMode('forgot')} aria-selected={isForgotPassword} role="tab">
              Forgot password
            </button>
          </div>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input type="text" id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username" disabled={loading} autoComplete="username" />
          </div>

          {isRegister && (
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={loading} autoComplete="email" />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="password">{isForgotPassword ? 'New Password' : 'Password'}</label>
            <div className="login-password-field">
              <input type={passwordVisible ? 'text' : 'password'} id="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isForgotPassword ? 'Enter new password' : 'Enter your password'} disabled={loading} autoComplete={isLogin ? 'current-password' : 'new-password'} />
              <button
                type="button"
                className="login-password-eye"
                onClick={() => setPasswordVisible((visible) => !visible)}
                disabled={loading}
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                title={passwordVisible ? 'Hide password' : 'Show password'}
              >
                <PasswordVisibilityIcon visible={passwordVisible} />
              </button>
            </div>
          </div>

          {!isLogin && (
            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <div className="login-password-field">
                <input type={confirmPasswordVisible ? 'text' : 'password'} id="confirmPassword" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder={isForgotPassword ? 'Confirm new password' : 'Confirm your password'} disabled={loading} autoComplete="new-password" />
                <button
                  type="button"
                  className="login-password-eye"
                  onClick={() => setConfirmPasswordVisible((visible) => !visible)}
                  disabled={loading}
                  aria-label={confirmPasswordVisible ? 'Hide confirm password' : 'Show confirm password'}
                  title={confirmPasswordVisible ? 'Hide confirm password' : 'Show confirm password'}
                >
                  <PasswordVisibilityIcon visible={confirmPasswordVisible} />
                </button>
              </div>
            </div>
          )}

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner" />
                {isLogin ? 'Signing in...' : isRegister ? 'Creating account...' : 'Updating password...'}
              </>
            ) : isLogin ? 'Sign in' : isRegister ? 'Create account' : 'Update password'}
          </button>
        </form>

        <p className="footer-text">
          {isLogin ? (
            <>
              Need an account? <button type="button" className="toggle-link" onClick={() => switchMode('register')}>Create account</button>
              <span className="footer-divider">|</span>
              <button type="button" className="toggle-link" onClick={() => switchMode('forgot')}>Forgot password?</button>
            </>
          ) : isRegister ? (
            <>
              Already have an account? <button type="button" className="toggle-link" onClick={() => switchMode('login')}>Sign in</button>
            </>
          ) : (
            <>
              Remember your password? <button type="button" className="toggle-link" onClick={() => switchMode('login')}>Sign in</button>
            </>
          )}
        </p>
      </section>
      )}
    </main>
  );
}
