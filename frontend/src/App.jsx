import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login';
import Home from './pages/Home';
import './App.css';

function App() {
  const appRoutes = [
    '/home',
    '/user-profile',
    '/manual-create-container',
    '/build-image',
    '/deployment',
    '/registry',
    '/network',
    '/volume',
    '/server-info',
    '/rbac',
    '/agents/create',
    '/agents/connected',
    '/monitoring',
    '/notifications',
    '/k8s/pod',
    '/k8s/namespace',
    '/k8s/deployment',
    '/k8s/statefulset',
    '/k8s/service',
    '/k8s/resources',
    '/k8s/images-registry',
    '/k8s/agent',
    '/k8s/autoscale',
    '/k8s/auth',
    '/k8s/configmap',
    '/k8s/secrets',
    '/k8s/pv-pvc',
    '/api/auth/deployment-detail',
    '/api/auth/deployment-detail/:deploymentId',
    '/api/auth/deployment-detail/*',
  ];

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />
        {appRoutes.map((path) => (
          <Route key={path} path={path} element={<Home />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
