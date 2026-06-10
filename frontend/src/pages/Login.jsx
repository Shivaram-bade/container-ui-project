import { useState } from 'react';
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

function InfrastructureScene() {
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
        <RecoveryDrones />
      </div>
      <Ocean />
      <RainLayer />
      <Fog />
      <SparkField />
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

function RecoveryDrones() {
  return (
    <div className="recovery-drones">
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
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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

  const switchMode = (nextIsLogin) => {
    setIsLogin(nextIsLogin);
    setPasswordVisible(false);
    setError('');
    setSuccess('');
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
          window.location.href = '/home';
        }, 800);
      } else {
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
          setIsLogin(true);
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
    <main className="login-container">
      <InfrastructureScene />

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
            <h1 className="login-title">Welcome back</h1>
            <span className="login-subtitle">Sign in with your username and password to manage containers, deployments, and agents.</span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="tab-buttons" role="tablist" aria-label="Authentication mode">
            <button type="button" className={`tab-btn ${isLogin ? 'active' : ''}`} onClick={() => switchMode(true)} aria-selected={isLogin} role="tab">
              Sign in
            </button>
            <button type="button" className={`tab-btn ${!isLogin ? 'active' : ''}`} onClick={() => switchMode(false)} aria-selected={!isLogin} role="tab">
              Create account
            </button>
          </div>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input type="text" id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username" disabled={loading} autoComplete="username" />
          </div>

          {!isLogin && (
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={loading} autoComplete="email" />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="login-password-field">
              <input type={passwordVisible ? 'text' : 'password'} id="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" disabled={loading} autoComplete={isLogin ? 'current-password' : 'new-password'} />
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
              <input type="password" id="confirmPassword" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm your password" disabled={loading} autoComplete="new-password" />
            </div>
          )}

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner" />
                {isLogin ? 'Signing in...' : 'Creating account...'}
              </>
            ) : isLogin ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="footer-text">
          {isLogin ? (
            <>
              Need an account? <button type="button" className="toggle-link" onClick={() => switchMode(false)}>Create account</button>
            </>
          ) : (
            <>
              Already have an account? <button type="button" className="toggle-link" onClick={() => switchMode(true)}>Sign in</button>
            </>
          )}
        </p>
      </section>
    </main>
  );
}
