import axios from 'axios';

const API_URL = import.meta.env.VITE_API_BASE_URL || '';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise = null;

const clearStoredSession = () => {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user');
};

const refreshAccessToken = async () => {
  const refreshToken = localStorage.getItem('refresh_token');
  if (!refreshToken) {
    throw new Error('Refresh token is missing.');
  }

  const response = await axios.post(`${API_URL}/api/auth/refresh-token/`, {
    refresh_token: refreshToken,
  });
  localStorage.setItem('access_token', response.data.access_token);
  localStorage.setItem('refresh_token', response.data.refresh_token);
  return response.data.access_token;
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const message = String(error.response?.data?.detail || error.response?.data?.error || '').toLowerCase();
    const isExpiredAccessToken = status === 403 && message.includes('access token has expired');

    if (!isExpiredAccessToken || originalRequest?._retry) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    try {
      refreshPromise = refreshPromise || refreshAccessToken();
      const newAccessToken = await refreshPromise;
      originalRequest.headers = originalRequest.headers || {};
      originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      clearStoredSession();
      if (window.location.pathname !== '/') {
        window.location.href = '/';
      }
      return Promise.reject(refreshError);
    } finally {
      refreshPromise = null;
    }
  }
);

export const authService = {
  login: (username, password, profileImage) => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);
    if (profileImage) {
      formData.append('profile_image', profileImage);
    }
    return api.post('/api/auth/login/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  register: (username, email, password, profileImage) => {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('email', email);
    formData.append('password', password);
    if (profileImage) {
      formData.append('profile_image', profileImage);
    }
    return api.post('/api/auth/register/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  getRbac: () => {
    return api.get('/api/auth/rbac/');
  },

  createRbacUser: (userData) => {
    return api.post('/api/auth/rbac/', { type: 'user', ...userData });
  },

  createRbacGroup: (groupData) => {
    return api.post('/api/auth/rbac/', { type: 'group', ...groupData });
  },

  deleteRbacItem: (type, id) => {
    return api.delete('/api/auth/rbac/', { data: { type, id } });
  },

  getServerInfo: (serverId) => {
    return api.get('/api/auth/server-info/', {
      params: serverId ? { server_id: serverId } : {},
    });
  },

  getUser: () => {
    return api.get('/api/auth/user/');
  },

  updateUserProfile: (profileData) => {
    const formData = new FormData();
    Object.entries(profileData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        formData.append(key, value);
      }
    });
    return api.put('/api/auth/user/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  changePassword: (passwordData) => {
    return api.post('/api/auth/change-password/', passwordData);
  },

  listAgents: () => {
    return api.get('/api/auth/agents/');
  },

  createAgent: (agentData) => {
    return api.post('/api/auth/agents/', agentData);
  },

  deleteAgent: (agentId) => {
    return api.delete('/api/auth/agents/', {
      data: { id: agentId },
    });
  },

  removeDeletedAgent: (agentId) => {
    return api.delete('/api/auth/agents/', {
      data: { id: agentId, purge_deleted: true },
    });
  },

  redeployAgent: (agentId, agentData = {}) => {
    return api.post('/api/auth/agents/', {
      redeploy_id: agentId,
      ...agentData,
    });
  },

  listContainers: (serverId) => {
    return api.get('/api/auth/manual-create-container/', {
      params: serverId ? { server_id: serverId } : {},
    });
  },

  createContainer: (containerData) => {
    return api.post('/api/auth/manual-create-container/', containerData);
  },

  getContainerDetail: (containerId, serverId, options = {}) => {
    return api.get('/api/auth/container-detail/', {
      params: { id: containerId, ...(serverId ? { server_id: serverId } : {}), ...options },
    });
  },

  getContainerMonitoring: (serverId, containerId = '') => {
    return api.get('/api/auth/container-monitoring/', {
      params: {
        ...(serverId ? { server_id: serverId } : {}),
        ...(containerId ? { id: containerId } : {}),
      },
    });
  },

  containerAction: (containerId, action, serverId) => {
    return api.post('/api/auth/container-action/', {
      id: containerId,
      action,
      ...(serverId ? { server_id: serverId } : {}),
    });
  },

  listRecycledContainers: () => {
    return api.get('/api/auth/container-recycle-bin/');
  },

  restoreRecycledContainer: (recycleId, serverId, image) => {
    return api.post('/api/auth/container-recycle-bin/', {
      id: recycleId,
      image,
      ...(serverId ? { server_id: serverId } : {}),
    });
  },

  deleteRecycledContainer: (recycleId, serverId) => {
    return api.delete('/api/auth/container-recycle-bin/', {
      data: {
        id: recycleId,
        ...(serverId ? { server_id: serverId } : {}),
      },
    });
  },

  attachNetwork: (containerId, networkId, serverId) => {
    return api.post('/api/auth/container-network/', {
      container_id: containerId,
      network_id: networkId,
      ...(serverId ? { server_id: serverId } : {}),
    });
  },

  detachNetwork: (containerId, networkId, serverId) => {
    return api.delete('/api/auth/container-network/', {
      data: {
        container_id: containerId,
        network_id: networkId,
        ...(serverId ? { server_id: serverId } : {}),
      },
    });
  },

  connectContainer: (containerId) => {
    return api.post('/api/auth/connect-container/', {
      id: containerId,
    });
  },

  connectVolume: (volumeData) => {
    return api.post('/api/auth/connect-volume/', volumeData);
  },

  listVolumeFiles: (volumeData) => {
    return api.get('/api/auth/volume-files/', {
      params: volumeData,
    });
  },

  downloadVolumeFile: (volumeData) => {
    return api.get('/api/auth/volume-files/', {
      params: { ...volumeData, download: 1 },
    });
  },

  volumeFileAction: (volumeData) => {
    return api.post('/api/auth/volume-files/', volumeData);
  },

  cleanupVolumeHelper: (serverId) => {
    return api.delete('/api/auth/volume-files/', {
      data: { ...(serverId ? { server_id: serverId } : {}) },
    });
  },

  sendShellCommand: (sessionId, command) => {
    return api.post('/api/auth/shell-command/', {
      session_id: sessionId,
      command,
    });
  },

  getShellOutput: (sessionId) => {
    return api.get('/api/auth/shell-output/', {
      params: { session_id: sessionId },
    });
  },

  closeShellSession: (sessionId) => {
    return api.delete('/api/auth/shell-session/', {
      data: { session_id: sessionId },
    });
  },

  autocompleteTerminal: ({ sessionId, serverId, input, cwd }) => {
    return api.post('/api/auth/terminal-autocomplete/', {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(serverId ? { server_id: serverId } : {}),
      input: input || '',
      cwd: cwd || '/',
    });
  },

  runAgentTerminalCommand: (serverId, command, cwd) => {
    return api.post('/api/auth/agent-terminal/', {
      server_id: serverId || 'local',
      command,
      cwd: cwd || '/',
    });
  },

  browseComposeFiles: (path) => {
    return api.get('/api/auth/browse-compose-files/', {
      params: path ? { path } : {},
    });
  },

  listDeployments: () => {
    return api.get('/api/auth/deployments/');
  },

  createDeployment: (deploymentData) => {
    return api.post('/api/auth/deployments/', deploymentData);
  },

  deleteDeployment: (deploymentId) => {
    return api.delete('/api/auth/deployments/', { data: { id: deploymentId } });
  },

  getDeploymentOutput: (jobId) => {
    return api.get(`/api/auth/deployment-output/${jobId}/`);
  },

  stopDeployment: (jobId) => {
    return api.post(`/api/auth/deployment-stop/${jobId}/`);
  },

  getDeploymentDetail: (deploymentId, options = {}) => {
    return api.get('/api/auth/deployment-detail/', {
      params: { id: deploymentId, ...options },
    });
  },

  getContainerLogs: (containerId, serverId) => {
    return api.get('/api/auth/container-logs/', {
      params: { id: containerId, ...(serverId ? { server_id: serverId } : {}) },
    });
  },

  attachVolume: (containerId, volumeName) => {
    return api.post('/api/auth/container-volume/', {
      container_id: containerId,
      volume_name: volumeName,
    });
  },

  detachVolume: (containerId, volumeName) => {
    return api.delete('/api/auth/container-volume/', {
      data: {
        container_id: containerId,
        volume_name: volumeName,
      },
    });
  },

  browseDockerfiles: (path, serverId) => {
    return api.get('/api/auth/browse-dockerfiles/', {
      params: {
        ...(path ? { path } : {}),
        ...(serverId ? { server_id: serverId } : {}),
      },
    });
  },

  buildImage: (imageName, dockerfilePath, serverId) => {
    return api.post('/api/auth/build-image/', {
      image_name: imageName,
      dockerfile_path: dockerfilePath,
      ...(serverId ? { server_id: serverId } : {}),
    });
  },

  listImages: (serverId) => {
    return api.get('/api/auth/build-image/', {
      params: serverId ? { server_id: serverId } : {},
    });
  },

  deleteImage: (imageData) => {
    return api.delete('/api/auth/build-image/', {
      data: imageData,
    });
  },

  getBuildImageOutput: (jobId) => {
    return api.get(`/api/auth/build-image-output/${jobId}/`);
  },

  stopBuildImage: (jobId) => {
    return api.post(`/api/auth/build-image-stop/${jobId}/`);
  },


  listRegistryImages: () => {
    return api.get('/api/registry/images/');
  },

  listRegistryTags: (repository) => {
    return api.get('/api/registry/tags/', {
      params: { image: repository },
    });
  },

  deployRegistryImage: (deploymentData) => {
    return api.post('/api/registry/deploy/', deploymentData);
  },

  listNetworks: (serverId) => {
    return api.get('/api/auth/network/', {
      params: serverId ? { server_id: serverId } : {},
    });
  },

  createNetwork: (networkData) => {
    return api.post('/api/auth/network/', networkData);
  },

  deleteNetwork: (networkData) => {
    return api.delete('/api/auth/network/', {
      data: networkData,
    });
  },

  listVolumes: (serverId) => {
    return api.get('/api/auth/volume/', {
      params: serverId ? { server_id: serverId } : {},
    });
  },

  createVolume: (volumeData) => {
    return api.post('/api/auth/volume/', volumeData);
  },

  deleteVolume: (volumeName, serverId) => {
    return api.delete('/api/auth/volume/', {
      data: {
        name: volumeName,
        ...(serverId ? { server_id: serverId } : {}),
      },
    });
  },
};

export default api;
