import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { authService } from '../services/authService';
import '../styles/Home.css';

const manualActions = [
  {
    id: 'container',
    icon: 'CT',
    path: '/manual-create-container',
    title: 'Containers',
   // description: 'Create, inspect, restart, stop, delete, and open terminals for containers.',
  },
  {
    id: 'image',
    icon: 'IM',
    path: '/build-image',
    title: 'Images',
   // description: 'Build images from Dockerfiles and remove images that are no longer needed.',
  },
  {
    id: 'network',
    icon: 'NW',
    path: '/network',
    title: 'Networks',
   // description: 'Create networks and manage container connectivity with confidence.',
  },
  {
    id: 'volume',
    icon: 'VL',
    path: '/volume',
    title: 'Volumes',
   // description: 'Create persistent storage and remove unused Docker volumes.',
  },
];

const registryAction = {
  id: 'registry',
  icon: 'RG',
  path: '/registry',
  title: 'Registry Deploy',
 // description: 'Deploy tagged images from the self-hosted registry to connected agents.',
};

const deploymentAction = {
  id: 'deployment',
  icon: 'DP',
  path: '/deployment',
  title: 'Deployments',
 // description: 'Deploy and operate full applications from Docker Compose files.',
};

const dashboardAction = {
  id: 'dashboard',
  icon: 'DB',
  path: '/home',
  title: 'Dashboard',
 // description: 'Monitor containers, images, volumes, networks, and deployments from one place.',
};

const homeActions = [...manualActions, deploymentAction];

const rbacAction = {
  id: 'rbac',
  icon: 'AC',
  path: '/rbac',
  title: 'Users & Access',
  //description: 'Create users, organize groups, and assign only the operations each user needs.',
};

const serverInfoAction = {
  id: 'server-info',
  icon: 'SV',
  path: '/server-info',
  title: 'Server Health',
  //description: 'Review operating system, resource, and Docker health information.',
};

const monitoringAction = {
  id: 'monitoring',
  icon: 'MO',
  path: '/monitoring',
  title: 'Monitoring',
  //description: 'Watch live health, utilization, networking, and lifecycle data for every container.',
};

const userProfileAction = {
  id: 'user-profile',
  icon: 'ME',
  path: '/user-profile',
  title: 'User Profile',
  description: 'Change your account password securely.',
};

const agentActions = [
  {
    id: 'agent-create',
    icon: 'AG',
    path: '/agents/create',
    title: 'Add Agent',
   // description: 'Create new server agents to manage Docker on multiple servers from this option.',
  },
  {
    id: 'agent-connected',
    icon: 'CN',
    path: '/agents/connected',
    title: 'Connected Agents',
   // description: 'See the health of every connected server Agent.',
  },
];

const BUILD_JOB_STORAGE_KEY = 'vitel-active-build-job-id';
const DEPLOY_JOB_STORAGE_KEY = 'vitel-active-deploy-job-id';
const LOCAL_SERVER_ID = 'local';
const buildImageAction = homeActions.find((action) => action.id === 'image');
const routedActions = [dashboardAction, ...homeActions, registryAction, serverInfoAction, monitoringAction, rbacAction, userProfileAction, ...agentActions];
const DashboardBackContext = createContext(null);

const getStoredUser = () => {
  try {
    const storedUser = localStorage.getItem('user');
    return storedUser ? JSON.parse(storedUser) : null;
  } catch (error) {
    localStorage.removeItem('user');
    return null;
  }
};


const CONTAINER_REGISTRIES = [
  {
    id: 'dockerhub',
    label: 'Docker Hub registry',
    endpoint: 'docker.io',
  },
  {
    id: 'dockerfile',
    label: 'Build from Dockerfile',
    endpoint: 'local build',
  },
];

const renderNavItem = (action, active, onClick) => (
  <button
    type="button"
    key={action.id}
    className={active ? 'home-nav-item nested active' : 'home-nav-item nested'}
    onClick={onClick}
  >
    <span className="home-nav-icon" aria-hidden="true">{action.icon || 'OP'}</span>
    <span className="home-nav-copy">
      <span className="home-nav-label">{action.title}</span>
      <small>{action.description}</small>
    </span>
  </button>
);

function PanelIntro({ title, description, children }) {
  const onBackToDashboard = useContext(DashboardBackContext);
  const hasActions = Boolean(children) || Boolean(onBackToDashboard);

  return (
    <div className="panel-intro">
      <div className="panel-intro-copy">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {hasActions ? (
        <div className="panel-intro-actions">
          {children}
          {onBackToDashboard ? (
            <button type="button" className="home-secondary-button dashboard-back-button" onClick={onBackToDashboard}>
              Back to Dashboard
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const isDeploymentDetailApiPath = (pathname) => pathname.startsWith('/api/auth/deployment-detail');

const getDeploymentIdFromApiPath = (locationValue) => {
  if (!isDeploymentDetailApiPath(locationValue.pathname)) return '';
  const pathMatch = locationValue.pathname.match(/^\/api\/auth\/deployment-detail\/(\d+)\/?$/);
  return pathMatch?.[1] || new URLSearchParams(locationValue.search || '').get('id') || '';
};

const getActionForPath = (pathname) => {
  if (isDeploymentDetailApiPath(pathname)) return deploymentAction;
  return routedActions.find((action) => action.path === pathname)
    || (localStorage.getItem(BUILD_JOB_STORAGE_KEY) ? buildImageAction : dashboardAction);
};


const joinVolumeGuiPath = (basePath, name) => {
  const baseParts = String(basePath || '').split('/').filter(Boolean);
  const nameParts = String(name || '').split('/').filter(Boolean);
  return [...baseParts, ...nameParts].join('/');
};

const getVolumeGuiParentPath = (path) => String(path || '').split('/').filter(Boolean).slice(0, -1).join('/');

const formatVolumeFileSize = (size) => {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
  reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
  reader.readAsDataURL(file);
});

const downloadBase64File = (filename, contentBase64) => {
  const binary = window.atob(contentBase64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const blob = new Blob([bytes]);
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'volume-file';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
};


const getVolumeFileMime = (filename) => {
  const extension = String(filename || '').split('.').pop()?.toLowerCase();
  const mimeByExtension = {
    txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml', csv: 'text/csv', env: 'text/plain', conf: 'text/plain', ini: 'text/plain', sh: 'text/x-shellscript', py: 'text/x-python', js: 'text/javascript', jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', css: 'text/css', html: 'text/html', htm: 'text/html', sql: 'text/plain', dockerfile: 'text/plain', gitignore: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  };
  return mimeByExtension[extension] || 'application/octet-stream';
};

const decodeBase64ToText = (contentBase64) => {
  const binary = window.atob(contentBase64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
};

const looksLikeText = (value) => {
  if (!value) return true;
  const sample = value.slice(0, 2048);
  let printable = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.85;
};

const buildVolumeFilePreview = ({ filename, path, size, contentBase64 }) => {
  const mime = getVolumeFileMime(filename);
  const dataUrl = `data:${mime};base64,${contentBase64 || ''}`;

  if (mime.startsWith('image/')) {
    return { filename, path, size, mime, kind: 'image', dataUrl };
  }
  if (mime === 'application/pdf') {
    return { filename, path, size, mime, kind: 'pdf', dataUrl };
  }
  if (mime.startsWith('video/')) {
    return { filename, path, size, mime, kind: 'video', dataUrl };
  }
  if (mime.startsWith('audio/')) {
    return { filename, path, size, mime, kind: 'audio', dataUrl };
  }

  const text = decodeBase64ToText(contentBase64 || '');
  if (mime.startsWith('text/') || ['application/json', 'application/xml'].includes(mime) || looksLikeText(text)) {
    return { filename, path, size, mime, kind: 'text', text };
  }

  return { filename, path, size, mime, kind: 'binary' };
};

export default function Home() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeAction, setActiveAction] = useState(() => getActionForPath(location.pathname));
  const [manualMenuOpen, setManualMenuOpen] = useState(false);
  const [rbacMenuOpen, setRbacMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const [serverInfoLoading, setServerInfoLoading] = useState(false);
  const [serverInfoError, setServerInfoError] = useState('');
  const [containerName, setContainerName] = useState('');
  const [containerRegistry, setContainerRegistry] = useState('dockerhub');
  const [containerImageName, setContainerImageName] = useState('');
  const [containerDockerfilePath, setContainerDockerfilePath] = useState('');
  const [containerHostPort, setContainerHostPort] = useState('');
  const [containerPort, setContainerPort] = useState('');
  const [containerNetwork, setContainerNetwork] = useState('bridge');
  const [containerVolume, setContainerVolume] = useState('');
  const [containerVolumeTarget, setContainerVolumeTarget] = useState('/data');
  const [containerServerId, setContainerServerId] = useState('');
  const [dashboardServerId, setDashboardServerId] = useState('');
  const [containerAdvancedOpen, setContainerAdvancedOpen] = useState(false);
  const [containerLoading, setContainerLoading] = useState(false);
  const [containerMessage, setContainerMessage] = useState('');
  const [containerCreateOutput, setContainerCreateOutput] = useState('');
  const [containerOutputOpen, setContainerOutputOpen] = useState(false);
  const [containerTab, setContainerTab] = useState('create');
  const [containers, setContainers] = useState([]);
  const [containersLoading, setContainersLoading] = useState(false);
  const [containersError, setContainersError] = useState('');
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [selectedContainerDetail, setSelectedContainerDetail] = useState(null);
  const [containerDetailLoading, setContainerDetailLoading] = useState(false);
  const [containerActionLoading, setContainerActionLoading] = useState(false);
  const [containerActionMessage, setContainerActionMessage] = useState('');
  const [recycledContainers, setRecycledContainers] = useState([]);
  const [recycledContainersLoading, setRecycledContainersLoading] = useState(false);
  const [recycledContainersError, setRecycledContainersError] = useState('');
  const [restoreContainerTarget, setRestoreContainerTarget] = useState(null);
  const [restoreContainerServerId, setRestoreContainerServerId] = useState('');
  const [restoreContainerImage, setRestoreContainerImage] = useState('');
  const [restoreContainerLoading, setRestoreContainerLoading] = useState(false);
  const [restoreContainerMessage, setRestoreContainerMessage] = useState('');
  const [containerInspectOutputOpen, setContainerInspectOutputOpen] = useState(false);
  const [containerInspectOutput, setContainerInspectOutput] = useState('');
  const [containerInspectTitle, setContainerInspectTitle] = useState('Container inspect');
  const [deleteRecycledContainerTarget, setDeleteRecycledContainerTarget] = useState(null);
  const [deleteRecycledContainerLoading, setDeleteRecycledContainerLoading] = useState(false);
  const [deleteRecycledContainerMessage, setDeleteRecycledContainerMessage] = useState('');
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [connectModalPosition, setConnectModalPosition] = useState({ x: 100, y: 100 });
  const [connectModalDrag, setConnectModalDrag] = useState(null);
  const [volumeConnectModalPosition, setVolumeConnectModalPosition] = useState({ x: 460, y: 120 });
  const [volumeConnectModalDrag, setVolumeConnectModalDrag] = useState(null);
  const [volumeGuiModalPosition, setVolumeGuiModalPosition] = useState({ x: 520, y: 140 });
  const [volumeGuiModalDrag, setVolumeGuiModalDrag] = useState(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectTarget, setConnectTarget] = useState(null);
  const [connectMessage, setConnectMessage] = useState('');
  const [shellSessionId, setShellSessionId] = useState(null);
  const [shellOutput, setShellOutput] = useState('');
  const [shellInput, setShellInput] = useState('');
  const [shellInputLoading, setShellInputLoading] = useState(false);
  const [activeShellContainer, setActiveShellContainer] = useState(null);
  const [volumeConnectModalOpen, setVolumeConnectModalOpen] = useState(false);
  const [volumeShellSessionId, setVolumeShellSessionId] = useState(null);
  const [volumeShellOutput, setVolumeShellOutput] = useState('');
  const [volumeShellInput, setVolumeShellInput] = useState('');
  const [volumeShellInputLoading, setVolumeShellInputLoading] = useState(false);
  const [activeVolumeShell, setActiveVolumeShell] = useState(null);
  const [volumeGuiModalOpen, setVolumeGuiModalOpen] = useState(false);
  const [activeVolumeGui, setActiveVolumeGui] = useState(null);
  const [volumeGuiPath, setVolumeGuiPath] = useState('');
  const [volumeGuiEntries, setVolumeGuiEntries] = useState([]);
  const [volumeGuiLoading, setVolumeGuiLoading] = useState(false);
  const [volumeGuiMessage, setVolumeGuiMessage] = useState('');
  const [volumeFilePreview, setVolumeFilePreview] = useState(null);
  const [volumeFilePreviewLoading, setVolumeFilePreviewLoading] = useState(false);
  const [volumeFilePreviewMessage, setVolumeFilePreviewMessage] = useState('');
  const shellSessionIdRef = useRef(null);
  const shellOutputTimerRef = useRef(null);
  const shellInputRef = useRef(null);
  const volumeShellSessionIdRef = useRef(null);
  const volumeShellOutputTimerRef = useRef(null);
  const volumeShellInputRef = useRef(null);
  const volumeGuiFileInputRef = useRef(null);
  const [imageName, setImageName] = useState('');
  const [dockerfilePath, setDockerfilePath] = useState('');
  const [buildLoading, setBuildLoading] = useState(() => Boolean(localStorage.getItem(BUILD_JOB_STORAGE_KEY)));
  const [buildOutput, setBuildOutput] = useState('');
  const [buildMessage, setBuildMessage] = useState('');
  const [buildJobId, setBuildJobId] = useState(() => localStorage.getItem(BUILD_JOB_STORAGE_KEY) || '');
  const [imageTab, setImageTab] = useState('build');
  const [images, setImages] = useState([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesError, setImagesError] = useState('');
  const [selectedImages, setSelectedImages] = useState([]);
  const [pendingDeleteImages, setPendingDeleteImages] = useState([]);
  const [imageDeleteLoading, setImageDeleteLoading] = useState(false);
  const [imageDeleteMessage, setImageDeleteMessage] = useState('');
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputModalPosition, setOutputModalPosition] = useState({ x: 0, y: 0 });
  const [outputModalDrag, setOutputModalDrag] = useState(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileBrowserData, setFileBrowserData] = useState(null);
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState('');
  const [deploymentName, setDeploymentName] = useState('');
  const [composeFilePath, setComposeFilePath] = useState('');
  const [deploymentServerId, setDeploymentServerId] = useState('');
  const [deploymentTab, setDeploymentTab] = useState('deploy');
  const [deploymentLoading, setDeploymentLoading] = useState(() => Boolean(localStorage.getItem(DEPLOY_JOB_STORAGE_KEY)));
  const [deploymentMessage, setDeploymentMessage] = useState('');
  const [deploymentOutput, setDeploymentOutput] = useState('');
  const [deploymentJobId, setDeploymentJobId] = useState(() => localStorage.getItem(DEPLOY_JOB_STORAGE_KEY) || '');
  const [deploymentOutputOpen, setDeploymentOutputOpen] = useState(false);
  const [composeBrowserOpen, setComposeBrowserOpen] = useState(false);
  const [composeBrowserData, setComposeBrowserData] = useState(null);
  const [composeBrowserLoading, setComposeBrowserLoading] = useState(false);
  const [composeBrowserError, setComposeBrowserError] = useState('');
  const [deployments, setDeployments] = useState([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);
  const [deploymentsError, setDeploymentsError] = useState('');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
  const [deploymentDetail, setDeploymentDetail] = useState(null);
  const [deploymentDetailLoading, setDeploymentDetailLoading] = useState(false);
  const [deploymentActionMessage, setDeploymentActionMessage] = useState('');
  const [deploymentActionLoading, setDeploymentActionLoading] = useState(false);
  const [registryImages, setRegistryImages] = useState([]);
  const [registryImagesLoading, setRegistryImagesLoading] = useState(false);
  const [registryImagesError, setRegistryImagesError] = useState('');
  const [registryAgentId, setRegistryAgentId] = useState('');
  const [registryImageId, setRegistryImageId] = useState('');
  const [registryContainerName, setRegistryContainerName] = useState('');
  const [registryRunArgs, setRegistryRunArgs] = useState('');
  const [registryUsername, setRegistryUsername] = useState('');
  const [registryPassword, setRegistryPassword] = useState('');
  const [registryDeployLoading, setRegistryDeployLoading] = useState(false);
  const [registryDeployMessage, setRegistryDeployMessage] = useState('');
  const [registryDeployOutput, setRegistryDeployOutput] = useState('');
  const [selectedDeploymentNetwork, setSelectedDeploymentNetwork] = useState('');
  const [selectedDeploymentVolume, setSelectedDeploymentVolume] = useState('');
  const [containerLogOutput, setContainerLogOutput] = useState('');
  const [containerLogTitle, setContainerLogTitle] = useState('');
  const [containerLogOutputOpen, setContainerLogOutputOpen] = useState(false);
  const [containerLogTarget, setContainerLogTarget] = useState(null);
  const [networkName, setNetworkName] = useState('');
  const [networkDriver, setNetworkDriver] = useState('bridge');
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkMessage, setNetworkMessage] = useState('');
  const [networkTab, setNetworkTab] = useState('create');
  const [networks, setNetworks] = useState([]);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksError, setNetworksError] = useState('');
  const [selectedNetworks, setSelectedNetworks] = useState([]);
  const [pendingDeleteNetworks, setPendingDeleteNetworks] = useState([]);
  const [networkDeleteLoading, setNetworkDeleteLoading] = useState(false);
  const [networkDeleteMessage, setNetworkDeleteMessage] = useState('');
  const [volumeName, setVolumeName] = useState('');
  const [volumeDriver, setVolumeDriver] = useState('local');
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeMessage, setVolumeMessage] = useState('');
  const [volumeTab, setVolumeTab] = useState('create');
  const [volumes, setVolumes] = useState([]);
  const [volumesLoading, setVolumesLoading] = useState(false);
  const [volumesError, setVolumesError] = useState('');
  const [selectedVolumes, setSelectedVolumes] = useState([]);
  const [pendingDeleteVolumes, setPendingDeleteVolumes] = useState([]);
  const [volumeDeleteLoading, setVolumeDeleteLoading] = useState(false);
  const [volumeDeleteMessage, setVolumeDeleteMessage] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentServerIp, setAgentServerIp] = useState('');
  const [agentPort, setAgentPort] = useState('19541');
  const [agentTab, setAgentTab] = useState('create');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedDeletedAgentId, setSelectedDeletedAgentId] = useState('');
  const [agentDeleteLoading, setAgentDeleteLoading] = useState(false);
  const [agentRedeployLoading, setAgentRedeployLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentMessage, setAgentMessage] = useState('');
  const [agentCreateOutput, setAgentCreateOutput] = useState('');
  const [agentDeleteOutput, setAgentDeleteOutput] = useState('');
  const [agentCreateOutputOpen, setAgentCreateOutputOpen] = useState(false);
  const [agentDeleteOutputOpen, setAgentDeleteOutputOpen] = useState(false);
  const [agents, setAgents] = useState([]);
  const [deletedAgents, setDeletedAgents] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState('');
  const [monitoringServerId, setMonitoringServerId] = useState('');
  const [monitoringContainers, setMonitoringContainers] = useState([]);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [monitoringError, setMonitoringError] = useState('');
  const [selectedMonitoringId, setSelectedMonitoringId] = useState('');
  const [monitoringDetail, setMonitoringDetail] = useState(null);
  const [monitoringDetailLoading, setMonitoringDetailLoading] = useState(false);
  const [monitoringHistory, setMonitoringHistory] = useState([]);
  const [monitoringActionLoading, setMonitoringActionLoading] = useState(false);
  const [monitoringMessage, setMonitoringMessage] = useState('');
  const [rbacTab, setRbacTab] = useState('user');
  const [rbacData, setRbacData] = useState({ operations: [], users: [], groups: [] });
  const [rbacLoading, setRbacLoading] = useState(false);
  const [rbacMessage, setRbacMessage] = useState('');
  const [rbacUsername, setRbacUsername] = useState('');
  const [rbacPassword, setRbacPassword] = useState('');
  const [rbacConfirmPassword, setRbacConfirmPassword] = useState('');
  const [rbacUserGroupId, setRbacUserGroupId] = useState('');
  const [rbacUserOperations, setRbacUserOperations] = useState([]);
  const [rbacGroupName, setRbacGroupName] = useState('');
  const [rbacGroupOperations, setRbacGroupOperations] = useState([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');
  const [currentUser, setCurrentUser] = useState(() => getStoredUser());
  const user = currentUser;
  const userOperations = new Set(user?.operations || []);
  const hasPermissionData = Array.isArray(user?.operations);
  const canOperate = (operation) => user?.is_admin || !hasPermissionData || userOperations.has('administrator') || userOperations.has(operation);
  const canSeeAction = (action) => {
    const actionOperations = {
      container: ['create_container', 'delete_container', 'connect_container'],
      image: ['build_images', 'delete_images'],
      network: ['create_network', 'delete_network'],
      volume: ['create_volume', 'delete_volume'],
      deployment: ['create_deployment', 'delete_deployment'],
      registry: ['create_deployment'],
      'server-info': ['view_server_info'],
      rbac: ['create_rbac_user', 'create_rbac_group'],
      'agent-create': ['create_agent'],
      'agent-connected': ['view_connected_agent'],
      monitoring: ['create_container', 'delete_container', 'connect_container', 'view_connected_agent'],
      dashboard: ['view_connected_agent', 'create_container', 'delete_container', 'connect_container', 'build_images', 'delete_images', 'create_network', 'delete_network', 'create_volume', 'delete_volume', 'create_deployment', 'delete_deployment'],
    }[action.id];
    return !actionOperations || actionOperations.some((operation) => canOperate(operation));
  };
  const visibleManualActions = manualActions.filter(canSeeAction);
  const visibleAgentActions = agentActions.filter(canSeeAction);
  const canCreateRbacUser = canOperate('create_rbac_user');
  const canCreateRbacGroup = canOperate('create_rbac_group');
  const isDashboardActive = activeAction.id === 'dashboard';
  const isUserProfileActive = activeAction.id === 'user-profile';
  const isServerInfoActive = activeAction.id === 'server-info';
  const isCreateAgentActive = activeAction.id === 'agent-create';
  const isConnectedAgentActive = activeAction.id === 'agent-connected';
  const isMonitoringActive = activeAction.id === 'monitoring';
  const isContainerActive = activeAction.id === 'container';
  const isBuildImageActive = activeAction.id === 'image';
  const isDeploymentActive = activeAction.id === 'deployment';
  const isRegistryActive = activeAction.id === 'registry';
  const redirectedDeploymentId = getDeploymentIdFromApiPath(location);
  const isNetworkActive = activeAction.id === 'network';
  const isVolumeActive = activeAction.id === 'volume';
  const isRbacActive = activeAction.id === 'rbac';

  useEffect(() => {
    setActiveAction(getActionForPath(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    authService.getUser()
      .then((response) => {
        setCurrentUser(response.data);
        localStorage.setItem('user', JSON.stringify(response.data));
      })
      .catch(() => {});
  }, []);

  const handleActionSelect = (action) => {
    setActiveAction(action);
    navigate(action.path);
  };

  const handleBackToDashboard = () => {
    handleActionSelect(dashboardAction);
  };

  const handleOpenUserProfile = () => {
    handleActionSelect(userProfileAction);
  };

  const handleChangePassword = async (event) => {
    event.preventDefault();
    setPasswordLoading(true);
    setPasswordMessage('');

    try {
      const response = await authService.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: confirmNewPassword,
      });
      if (response.data?.access_token) {
        localStorage.setItem('access_token', response.data.access_token);
      }
      if (response.data?.refresh_token) {
        localStorage.setItem('refresh_token', response.data.refresh_token);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setPasswordMessage(response.data?.message || 'Password updated successfully.');
    } catch (error) {
      const data = error.response?.data;
      setPasswordMessage(data?.error || data?.detail || 'Unable to update password.');
    } finally {
      setPasswordLoading(false);
    }
  };

  const loadServerInfo = async (showLoading = true) => {
    if (showLoading) {
      setServerInfoLoading(true);
    }
    setServerInfoError('');

    try {
      const response = await authService.getServerInfo();
      setServerInfo(response.data);
    } catch (error) {
      setServerInfoError('Unable to load server information.');
    } finally {
      if (showLoading) {
        setServerInfoLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!isServerInfoActive) {
      return undefined;
    }

    loadServerInfo(!serverInfo);
    const refreshTimer = window.setInterval(() => {
      loadServerInfo(false);
    }, 60000);

    return () => window.clearInterval(refreshTimer);
  }, [isServerInfoActive]);

  const loadAgents = async () => {
    setAgentsLoading(true);
    setAgentsError('');

    try {
      const response = await authService.listAgents();
      setAgents(response.data.agents || []);
      setDeletedAgents(response.data.deleted_agents || []);
    } catch (error) {
      const data = error.response?.data;
      setAgents([]);
      setDeletedAgents([]);
      setAgentsError(data?.error || data?.detail || 'Unable to load connected agents.');
    } finally {
      setAgentsLoading(false);
    }
  };

  useEffect(() => {
    if (!isConnectedAgentActive) {
      return undefined;
    }

    loadAgents();
    const refreshTimer = window.setInterval(loadAgents, 60000);
    return () => window.clearInterval(refreshTimer);
  }, [isConnectedAgentActive]);

  useEffect(() => {
    if (!isCreateAgentActive || agentTab !== 'delete') {
      return undefined;
    }

    loadAgents();
    const refreshTimer = window.setInterval(loadAgents, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [isCreateAgentActive, agentTab]);

  const loadRbac = async () => {
    setRbacLoading(true);
    try {
      const response = await authService.getRbac();
      setRbacData(response.data);
    } catch (error) {
      const data = error.response?.data;
      setRbacMessage(data?.error || 'Unable to load RBAC data.');
    } finally {
      setRbacLoading(false);
    }
  };

  useEffect(() => {
    if (isRbacActive) {
      loadRbac();
    }
  }, [isRbacActive]);

  const handleCreateRbacUser = async (event) => {
    event.preventDefault();
    setRbacLoading(true);
    setRbacMessage('');
    try {
      await authService.createRbacUser({
        username: rbacUsername,
        password: rbacPassword,
        confirm_password: rbacConfirmPassword,
        group_id: rbacUserGroupId,
        operations: rbacUserGroupId ? [] : rbacUserOperations,
      });
      setRbacMessage('User created.');
      setRbacUsername('');
      setRbacPassword('');
      setRbacConfirmPassword('');
      setRbacUserGroupId('');
      setRbacUserOperations([]);
      await loadRbac();
    } catch (error) {
      const data = error.response?.data;
      setRbacMessage(data?.error || 'Unable to create user.');
    } finally {
      setRbacLoading(false);
    }
  };

  const handleCreateRbacGroup = async (event) => {
    event.preventDefault();
    setRbacLoading(true);
    setRbacMessage('');
    try {
      await authService.createRbacGroup({ name: rbacGroupName, operations: rbacGroupOperations });
      setRbacMessage('Group created.');
      setRbacGroupName('');
      setRbacGroupOperations([]);
      await loadRbac();
    } catch (error) {
      const data = error.response?.data;
      setRbacMessage(data?.error || 'Unable to create group.');
    } finally {
      setRbacLoading(false);
    }
  };

  const handleDeleteRbacItem = async (type, id) => {
    setRbacLoading(true);
    setRbacMessage('');
    try {
      await authService.deleteRbacItem(type, id);
      setRbacMessage(`${type === 'user' ? 'User' : 'Group'} deleted.`);
      await loadRbac();
    } catch (error) {
      const data = error.response?.data;
      setRbacMessage(data?.error || 'Unable to delete item.');
    } finally {
      setRbacLoading(false);
    }
  };

  useEffect(() => {
    if (!agentMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setAgentMessage('');
    }, 5000);

    return () => window.clearTimeout(clearTimer);
  }, [agentMessage]);

  const handleCreateAgent = async (event) => {
    event.preventDefault();
    setAgentLoading(true);
    setAgentMessage('');
    setAgentCreateOutput('Creating Docker agent install command...\n');
    setAgentCreateOutputOpen(true);

    try {
      const response = await authService.createAgent({
        name: agentName,
        server_ip: agentServerIp,
        install_method: 'docker',
        port: agentPort,
        browser_hostname: window.location.hostname,
      });
      const successMessage = response.data.manual_install
        ? 'Agent install steps created. Run them on the target server.'
        : 'Agent created and started in the background.';
      const outputLines = [
        response.data.command ? `$ ${response.data.command}` : '',
        response.data.output || '',
        response.data.success ? successMessage : '',
      ].filter(Boolean);
      setAgentCreateOutput(outputLines.join('\n'));
      setAgentMessage(successMessage);
      setAgentName('');
      setAgentServerIp('');
      setAgentPort('19541');
      loadAgents();
    } catch (error) {
      const data = error.response?.data;
      const outputLines = [
        data?.command ? `$ ${data.command}` : '',
        data?.output || data?.error || error.message || 'Unable to create agent.',
      ].filter(Boolean);
      setAgentCreateOutput(outputLines.join('\n'));
      setAgentMessage(data?.error || data?.detail || 'Unable to create agent.');
    } finally {
      setAgentLoading(false);
    }
  };

  const handleDeleteAgent = async (agentId) => {
    if (!agentId || agentId === 'local') return;
    setAgentDeleteLoading(true);
    setAgentMessage('');
    setAgentDeleteOutput('Starting remote agent removal...\n');
    setAgentDeleteOutputOpen(true);

    try {
      const response = await authService.deleteAgent(agentId);
      const outputLines = [
        response.data.command ? `$ ${response.data.command}` : '',
        response.data.output || '',
        response.data.success && !response.data.remote_cleanup_skipped ? 'Agent deleted from the selected server.' : '',
      ].filter(Boolean);
      setAgentDeleteOutput(outputLines.join('\n'));
      setAgentMessage(
        response.data.remote_cleanup_skipped
          ? 'Agent moved to deleted agents. Run the manual cleanup command shown below on the target server.'
          : 'Agent deleted from the selected server and moved to deleted agents.'
      );
      setSelectedAgentId('');
      setSelectedDeletedAgentId(response.data.agent?.id ? String(response.data.agent.id) : '');
      await loadAgents();
    } catch (error) {
      const data = error.response?.data;
      const outputLines = [
        data?.command ? `$ ${data.command}` : '',
        data?.output || data?.error || error.message || 'Unable to delete agent.',
      ].filter(Boolean);
      setAgentDeleteOutput(outputLines.join('\n'));
      setAgentMessage(data?.error || data?.detail || 'Unable to delete agent.');
    } finally {
      setAgentDeleteLoading(false);
    }
  };

  const handleRedeployAgent = async (agentId) => {
    if (!agentId || agentId === 'local') return;
    setAgentRedeployLoading(true);
    setAgentMessage('');
    setAgentDeleteOutput('Starting agent redeploy...\n');
    setAgentDeleteOutputOpen(true);

    try {
      const response = await authService.redeployAgent(agentId, {
        browser_hostname: window.location.hostname,
      });
      const outputLines = [
        response.data.command ? `$ ${response.data.command}` : '',
        response.data.output || '',
        response.data.success ? 'Agent redeploy started on the selected server.' : '',
      ].filter(Boolean);
      setAgentDeleteOutput(outputLines.join('\n'));
      setAgentMessage('Agent redeploy started on the selected server.');
      setSelectedDeletedAgentId('');
      await loadAgents();
    } catch (error) {
      const data = error.response?.data;
      const outputLines = [
        data?.command ? `$ ${data.command}` : '',
        data?.output || data?.error || error.message || 'Unable to redeploy agent.',
      ].filter(Boolean);
      setAgentDeleteOutput(outputLines.join('\n'));
      setAgentMessage(data?.error || data?.detail || 'Unable to redeploy agent.');
    } finally {
      setAgentRedeployLoading(false);
    }
  };

  const getSelectedDockerServerId = () => containerServerId || LOCAL_SERVER_ID;
  const getSelectedDashboardServerId = () => dashboardServerId || LOCAL_SERVER_ID;

  const loadImages = async (serverId = getSelectedDockerServerId()) => {
    setImagesLoading(true);
    setImagesError('');

    try {
      const response = await authService.listImages(serverId);
      setImages(response.data.images || []);
    } catch (error) {
      const data = error.response?.data;
      setImages([]);
      setImagesError(data?.error || data?.output || 'Unable to load images.');
    } finally {
      setImagesLoading(false);
    }
  };

  useEffect(() => {
    if (isBuildImageActive && imageTab === 'delete') {
      loadImages();
    }
  }, [isBuildImageActive, imageTab]);

  useEffect(() => {
    if (!imageDeleteMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setImageDeleteMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [imageDeleteMessage]);

  useEffect(() => {
    if (!networkDeleteMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setNetworkDeleteMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [networkDeleteMessage]);

  useEffect(() => {
    if (!volumeDeleteMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setVolumeDeleteMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [volumeDeleteMessage]);

  useEffect(() => {
    if (!buildMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setBuildMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [buildMessage]);

  useEffect(() => {
    if (!networkMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setNetworkMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [networkMessage]);

  useEffect(() => {
    if (!volumeMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setVolumeMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [volumeMessage]);

  useEffect(() => {
    if (!containerMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setContainerMessage('');
    }, 10000);

    return () => window.clearTimeout(clearTimer);
  }, [containerMessage]);

  useEffect(() => {
    if (!containerActionMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setContainerActionMessage('');
    }, 5000);

    return () => window.clearTimeout(clearTimer);
  }, [containerActionMessage]);

  useEffect(() => {
    if (!connectMessage) {
      return undefined;
    }

    const clearTimer = window.setTimeout(() => {
      setConnectMessage('');
    }, 8000);

    return () => window.clearTimeout(clearTimer);
  }, [connectMessage]);

  useEffect(() => {
    return () => {
      if (shellOutputTimerRef.current) {
        clearInterval(shellOutputTimerRef.current);
      }
      if (shellSessionIdRef.current) {
        authService.closeShellSession(shellSessionIdRef.current).catch(() => {});
      }
      if (volumeShellOutputTimerRef.current) {
        clearInterval(volumeShellOutputTimerRef.current);
      }
      if (volumeShellSessionIdRef.current) {
        authService.closeShellSession(volumeShellSessionIdRef.current).catch(() => {});
      }
    };
  }, []);

  const loadNetworks = async (serverId = getSelectedDockerServerId()) => {
    setNetworksLoading(true);
    setNetworksError('');

    try {
      const response = await authService.listNetworks(serverId);
      setNetworks(response.data.networks || []);
    } catch (error) {
      const data = error.response?.data;
      setNetworks([]);
      setNetworksError(data?.error || data?.output || 'Unable to load networks.');
    } finally {
      setNetworksLoading(false);
    }
  };

  useEffect(() => {
    if (isNetworkActive && networkTab === 'delete') {
      loadNetworks();
    }
  }, [isNetworkActive, networkTab]);

  const loadVolumes = async (serverId = getSelectedDockerServerId()) => {
    setVolumesLoading(true);
    setVolumesError('');

    try {
      const response = await authService.listVolumes(serverId);
      setVolumes(response.data.volumes || []);
    } catch (error) {
      const data = error.response?.data;
      setVolumes([]);
      setVolumesError(data?.error || data?.output || 'Unable to load volumes.');
    } finally {
      setVolumesLoading(false);
    }
  };

  useEffect(() => {
    if (isVolumeActive && volumeTab === 'delete') {
      loadVolumes();
    }
  }, [isVolumeActive, volumeTab]);

  useEffect(() => {
    if (isContainerActive) {
      loadNetworks(getSelectedDockerServerId());
      loadVolumes(getSelectedDockerServerId());
      loadAgents();
    }
  }, [isContainerActive, containerServerId]);

  useEffect(() => {
    if (!isDashboardActive) {
      return undefined;
    }

    const loadDashboardData = () => {
      const serverId = getSelectedDashboardServerId();
      loadAgents();
      loadContainers(serverId);
      loadImages(serverId);
      loadNetworks(serverId);
      loadVolumes(serverId);
      loadDeployments();
      loadRecycledContainers();
    };

    const syncDashboardContainers = () => {
      if (document.visibilityState !== 'visible') return;
      const serverId = getSelectedDashboardServerId();
      loadContainers(serverId, { silent: true, preserveSelection: true });
      loadRecycledContainers({ silent: true });
    };

    loadDashboardData();
    const refreshTimer = window.setInterval(loadDashboardData, 30000);
    const containerSyncTimer = window.setInterval(syncDashboardContainers, 5000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(containerSyncTimer);
    };
  }, [isDashboardActive, dashboardServerId]);

  useEffect(() => {
    if (!buildJobId || !buildLoading) {
      return undefined;
    }

    const loadBuildOutput = async () => {
      try {
        const response = await authService.getBuildImageOutput(buildJobId);
        const data = response.data;
        setBuildOutput(data.output || '');

        if (!data.running) {
          setBuildLoading(false);
          localStorage.removeItem(BUILD_JOB_STORAGE_KEY);
          setBuildMessage(
            data.stopped
              ? 'Image build stopped.'
              : data.success
                ? 'Image build completed.'
                : 'Image build failed.'
          );
        }
      } catch (error) {
        setBuildLoading(false);
        localStorage.removeItem(BUILD_JOB_STORAGE_KEY);
        setBuildMessage('Unable to load build output.');
      }
    };

    loadBuildOutput();
    const outputTimer = window.setInterval(loadBuildOutput, 1500);

    return () => window.clearInterval(outputTimer);
  }, [buildJobId, buildLoading]);

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('user');
    window.location.href = '/';
  };

  const handleCreateContainer = async (event) => {
    event.preventDefault();
    setContainerMessage('');
    const isDockerfileSource = containerRegistry === 'dockerfile';
    setContainerCreateOutput(isDockerfileSource ? 'Starting Dockerfile build and container create...\n' : 'Pulling image and starting container create...\n');
    setContainerLoading(true);

    const ports = [];
    if (containerHostPort.trim() && containerPort.trim()) {
      ports.push({
        host_port: containerHostPort.trim(),
        container_port: containerPort.trim(),
        protocol: 'tcp',
      });
    }

    const selectedVolumesForContainer = [];
    if (containerVolume && containerVolumeTarget.trim()) {
      selectedVolumesForContainer.push({
        source: containerVolume,
        target: containerVolumeTarget.trim(),
      });
    }

    try {
      const response = await authService.createContainer({
        name: containerName,
        image: isDockerfileSource
          ? containerImageName.trim()
          : getContainerImageReference(containerRegistry, containerImageName),
        image_source: isDockerfileSource ? 'dockerfile' : 'dockerhub',
        dockerfile_path: isDockerfileSource ? containerDockerfilePath.trim() : '',
        network: containerNetwork || 'bridge',
        server_id: containerServerId || LOCAL_SERVER_ID,
        browser_hostname: window.location.hostname,
        ports,
        volumes: selectedVolumesForContainer,
      });
      const containerId = response.data.container_id ? ` ${response.data.container_id}` : '';
      const outputLines = [
        response.data.command ? `$ ${response.data.command}` : '',
        response.data.output || '',
        response.data.success ? `Container created successfully.${containerId}` : '',
      ].filter(Boolean);
      setContainerCreateOutput(outputLines.join('\n'));
      setContainerMessage(`Container created successfully.${containerId}`);
      setContainerName('');
      setContainerImageName('');
      setContainerHostPort('');
      setContainerPort('');
      setContainerNetwork('bridge');
      setContainerVolume('');
      setContainerVolumeTarget('/data');
      if (isDockerfileSource) {
        setContainerDockerfilePath('');
      }
      loadAgents();
      loadContainers(getSelectedDockerServerId());
    } catch (error) {
      const data = error.response?.data;
      const outputLines = [
        data?.command ? `$ ${data.command}` : '',
        data?.output || data?.error || error.message || 'Unable to create container.',
      ].filter(Boolean);
      setContainerCreateOutput(outputLines.join('\n'));
      setContainerMessage(data?.error || data?.output || 'Unable to create container.');
    } finally {
      setContainerLoading(false);
    }
  };

  const loadContainers = async (
    serverId = getSelectedDockerServerId(),
    { silent = false, preserveSelection = false } = {}
  ) => {
    if (!silent) setContainersLoading(true);
    setContainersError('');
    if (!preserveSelection) {
      setSelectedContainer(null);
      setSelectedContainerDetail(null);
    }

    try {
      const response = await authService.listContainers(serverId);
      setContainers(response.data.containers || []);
    } catch (error) {
      const data = error.response?.data;
      if (!silent) setContainers([]);
      setContainersError(data?.error || data?.output || 'Unable to load containers.');
    } finally {
      if (!silent) setContainersLoading(false);
    }
  };

  const loadMonitoringContainers = async (serverId = monitoringServerId || LOCAL_SERVER_ID, { silent = false } = {}) => {
    if (!silent) setMonitoringLoading(true);
    setMonitoringError('');
    try {
      const response = await authService.getContainerMonitoring(serverId);
      const nextContainers = response.data.containers || [];
      setMonitoringContainers(nextContainers);
      if (selectedMonitoringId && !nextContainers.some((container) => container.id === selectedMonitoringId)) {
        setSelectedMonitoringId('');
        setMonitoringDetail(null);
        setMonitoringHistory([]);
      }
    } catch (error) {
      const data = error.response?.data;
      if (!silent) setMonitoringContainers([]);
      setMonitoringError(data?.error || data?.output || 'Unable to load container monitoring data.');
    } finally {
      if (!silent) setMonitoringLoading(false);
    }
  };

  const loadMonitoringDetail = async (containerId = selectedMonitoringId, { silent = false } = {}) => {
    if (!containerId) return;
    if (!silent) setMonitoringDetailLoading(true);
    try {
      const response = await authService.getContainerMonitoring(monitoringServerId || LOCAL_SERVER_ID, containerId);
      const detail = response.data.container || null;
      setMonitoringDetail(detail);
      if (detail) {
        const network = parseNetworkIOValue(detail.network_io);
        setMonitoringHistory((current) => [...current, {
          at: Date.now(),
          cpu: parsePercentValue(detail.cpu_percent),
          memory: parsePercentValue(detail.memory_percent),
          networkRx: network.rx,
          networkTx: network.tx,
        }].slice(-24));
      }
    } catch (error) {
      const data = error.response?.data;
      setMonitoringError(data?.error || data?.output || 'Unable to load live container statistics.');
    } finally {
      if (!silent) setMonitoringDetailLoading(false);
    }
  };

  const loadRecycledContainers = async ({ silent = false } = {}) => {
    if (!silent) setRecycledContainersLoading(true);
    setRecycledContainersError('');
    try {
      const response = await authService.listRecycledContainers();
      setRecycledContainers(response.data.containers || []);
    } catch (error) {
      const data = error.response?.data;
      if (!silent) setRecycledContainers([]);
      setRecycledContainersError(data?.error || 'Unable to load container recycle bin.');
    } finally {
      if (!silent) setRecycledContainersLoading(false);
    }
  };

  useEffect(() => {
    if (isContainerActive && (containerTab === 'existing' || containerTab === 'stopped' || containerTab === 'recyclebin')) {
      loadContainers(getSelectedDockerServerId());
      loadNetworks(getSelectedDockerServerId());
      loadVolumes(getSelectedDockerServerId());
      loadImages(getSelectedDockerServerId());
    }
    if (isContainerActive && ['existing', 'stopped', 'recyclebin'].includes(containerTab)) {
      loadRecycledContainers();
    }
  }, [isContainerActive, containerTab, containerServerId]);


  useEffect(() => {
    if (!isContainerActive || !['existing', 'stopped', 'recyclebin'].includes(containerTab)) {
      return undefined;
    }

    const syncContainers = () => {
      if (document.visibilityState !== 'visible') return;
      loadContainers(getSelectedDockerServerId(), { silent: true, preserveSelection: true });
      loadRecycledContainers({ silent: true });
    };

    const syncTimer = window.setInterval(syncContainers, 5000);
    return () => window.clearInterval(syncTimer);
  }, [isContainerActive, containerTab, containerServerId]);

  useEffect(() => {
    if (!isMonitoringActive) return undefined;
    setSelectedMonitoringId('');
    setMonitoringDetail(null);
    setMonitoringHistory([]);
    loadAgents();
    loadMonitoringContainers(monitoringServerId || LOCAL_SERVER_ID);
    const syncMonitoringInventory = () => {
      if (document.visibilityState === 'visible') {
        loadMonitoringContainers(monitoringServerId || LOCAL_SERVER_ID, { silent: true });
      }
    };
    const timer = window.setInterval(syncMonitoringInventory, 10000);
    return () => window.clearInterval(timer);
  }, [isMonitoringActive, monitoringServerId]);

  useEffect(() => {
    if (!isMonitoringActive || !selectedMonitoringId) return undefined;
    loadMonitoringDetail(selectedMonitoringId);
    const syncMonitoringDetail = () => {
      if (document.visibilityState === 'visible') {
        loadMonitoringDetail(selectedMonitoringId, { silent: true });
      }
    };
    const timer = window.setInterval(syncMonitoringDetail, 3000);
    return () => window.clearInterval(timer);
  }, [isMonitoringActive, monitoringServerId, selectedMonitoringId]);

  useEffect(() => {
    const resourceInventoryVisible =
      (isBuildImageActive && imageTab === 'delete') ||
      (isNetworkActive && networkTab === 'delete') ||
      (isVolumeActive && volumeTab === 'delete');
    if (!resourceInventoryVisible) return undefined;
    const serverId = getSelectedDockerServerId();
    loadMonitoringContainers(serverId, { silent: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadMonitoringContainers(serverId, { silent: true });
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [isBuildImageActive, imageTab, isNetworkActive, networkTab, isVolumeActive, volumeTab, containerServerId]);

  useEffect(() => {
    if (!selectedContainer) return;
    const selectedId = getContainerId(selectedContainer);
    const currentContainer = containers.find((container) => getContainerId(container) === selectedId);
    if (currentContainer) {
      if (currentContainer !== selectedContainer) setSelectedContainer(currentContainer);
      return;
    }

    setSelectedContainer(null);
    setSelectedContainerDetail(null);
    setContainerInspectOutputOpen(false);
    if (String(containerLogTarget?.id || '') === String(selectedId)) {
      setContainerLogOutputOpen(false);
      setContainerLogTarget(null);
    }
    if (String(activeShellContainer?.id || '') === String(selectedId)) {
      closeActiveShellSession();
      setConnectModalOpen(false);
      setActiveShellContainer(null);
      setShellOutput('');
    }
    setContainerActionMessage('Container no longer exists on the selected server. The list was synchronized with Docker.');
  }, [containers]);

  const handleSelectContainer = async (container) => {
    setSelectedContainer(container);
    setContainerDetailLoading(true);
    setSelectedContainerDetail(null);
    setContainerActionMessage('');

    try {
      const response = await authService.getContainerDetail(
        container.ID || container.Id || container.id,
        getSelectedDockerServerId(),
        { browser_hostname: window.location.hostname }
      );
      if (response.data.success && response.data.container) {
        setSelectedContainerDetail(
          Array.isArray(response.data.container)
            ? response.data.container[0]
            : response.data.container
        );
      }
    } catch (error) {
      setContainerActionMessage('Unable to load container details.');
    } finally {
      setContainerDetailLoading(false);
    }
  };

  const handleContainerAction = async (action) => {
    if (!selectedContainer) return;
    setContainerActionMessage('');
    setContainerActionLoading(true);

    try {
      const response = await authService.containerAction(
        selectedContainer.ID || selectedContainer.Id || selectedContainer.id,
        action,
        getSelectedDockerServerId()
      );
      if (action === 'delete' && response.data?.recycled_container) {
        setContainerActionMessage(`Container deleted successfully and moved to recycle bin from ${response.data.recycled_container.source_label}.`);
        loadRecycledContainers();
      } else {
        setContainerActionMessage(`Container ${action}ed successfully.`);
      }
      loadContainers(getSelectedDockerServerId());
      loadAgents();
      setTimeout(() => setContainerActionMessage(''), 3000);
    } catch (error) {
      const data = error.response?.data;
      setContainerActionMessage(data?.error || data?.output || `Failed to ${action} container.`);
    } finally {
      setContainerActionLoading(false);
    }
  };

  const handleOpenRestoreContainer = (container) => {
    const expectedServerId = String(container.agent_id || 'local');
    setRestoreContainerTarget(container);
    setRestoreContainerServerId(expectedServerId === 'local' ? '' : expectedServerId);
    setRestoreContainerImage(container.image || '');
    setRestoreContainerMessage(`Restoring ${container.container_name}. Choose the original agent and the Docker image name for the restored container.`);
  };

  const handleCancelRestoreContainer = () => {
    if (restoreContainerLoading) return;
    setRestoreContainerTarget(null);
    setRestoreContainerServerId('');
    setRestoreContainerImage('');
    setRestoreContainerMessage('');
  };

  const handleConfirmRestoreContainer = async () => {
    if (!restoreContainerTarget) return;
    setRestoreContainerLoading(true);
    setRestoreContainerMessage(`Restoring ${restoreContainerTarget.container_name} on ${restoreContainerTarget.source_label}...`);
    try {
      const response = await authService.restoreRecycledContainer(
        restoreContainerTarget.id,
        restoreContainerServerId || LOCAL_SERVER_ID,
        restoreContainerImage.trim()
      );
      setRestoreContainerMessage(response.data?.output || `Container ${restoreContainerTarget.container_name} restored successfully.`);
      await loadRecycledContainers();
      await loadAgents();
      if (containerServerId === restoreContainerServerId || (!containerServerId && !restoreContainerServerId)) {
        await loadContainers(getSelectedDockerServerId());
      }
      window.setTimeout(() => {
        setRestoreContainerTarget(null);
        setRestoreContainerServerId('');
        setRestoreContainerImage('');
        setRestoreContainerMessage('');
      }, 1400);
    } catch (error) {
      const data = error.response?.data;
      setRestoreContainerMessage(data?.error || data?.output || 'Unable to restore container.');
    } finally {
      setRestoreContainerLoading(false);
    }
  };

  const handleOpenDeleteRecycledContainer = (container) => {
    setDeleteRecycledContainerTarget(container);
    setDeleteRecycledContainerMessage('');
  };

  const handleCancelDeleteRecycledContainer = () => {
    if (deleteRecycledContainerLoading) return;
    setDeleteRecycledContainerTarget(null);
    setDeleteRecycledContainerMessage('');
  };

  const handleConfirmDeleteRecycledContainer = async () => {
    if (!deleteRecycledContainerTarget) return;
    setDeleteRecycledContainerLoading(true);
    setDeleteRecycledContainerMessage(`Deleting ${deleteRecycledContainerTarget.container_name} from the recycle bin...`);
    try {
      await authService.deleteRecycledContainer(
        deleteRecycledContainerTarget.id,
        deleteRecycledContainerTarget.target_server_id || deleteRecycledContainerTarget.agent_id || LOCAL_SERVER_ID
      );
      await loadRecycledContainers();
      setDeleteRecycledContainerTarget(null);
      setDeleteRecycledContainerMessage('');
    } catch (error) {
      const data = error.response?.data;
      setDeleteRecycledContainerMessage(data?.error || 'Unable to delete the container from the recycle bin.');
    } finally {
      setDeleteRecycledContainerLoading(false);
    }
  };

  const loadContainerLogs = async (containerId, serverId = LOCAL_SERVER_ID, title = 'Container logs') => {
    if (!containerId) return;
    setContainerLogTitle(title);
    setContainerLogTarget({ id: containerId, serverId, title });
    setContainerLogOutput((current) => current || 'Loading container logs...');
    setContainerLogOutputOpen(true);

    try {
      const response = await authService.getContainerLogs(containerId, serverId);
      setContainerLogOutput(response.data.output || 'No log output.');
    } catch (error) {
      const data = error.response?.data;
      setContainerLogOutput(data?.output || data?.error || 'Unable to load container logs.');
    }
  };

  const handleContainerLogs = () => {
    if (!selectedContainer) return;
    const containerId = selectedContainer.ID || selectedContainer.Id || selectedContainer.id;
    const name = selectedContainer.Names?.[0]?.replace(/^[/]/, '') || containerId;
    loadContainerLogs(containerId, getSelectedDockerServerId(), name + ' logs');
  };


  const handleContainerInspect = () => {
    if (!selectedContainerDetail) return;
    const containerId = selectedContainer.ID || selectedContainer.Id || selectedContainer.id;
    const name = selectedContainer.Names?.[0]?.replace(/^[/]/, '') || containerId;
    setContainerInspectTitle(`${name} inspect`);
    setContainerInspectOutput(JSON.stringify(selectedContainerDetail, null, 2));
    setContainerInspectOutputOpen(true);
  };

  const handleMonitoringAction = async (action) => {
    if (!monitoringDetail?.id) return;
    setMonitoringActionLoading(true);
    setMonitoringMessage('');
    try {
      const response = await authService.containerAction(
        monitoringDetail.id,
        action,
        monitoringServerId || LOCAL_SERVER_ID
      );
      if (action === 'delete') {
        setMonitoringMessage('Container deleted and moved to the recycle bin.');
        setSelectedMonitoringId('');
        setMonitoringDetail(null);
        setMonitoringHistory([]);
        if (response.data?.recycled_container) loadRecycledContainers();
      } else {
        setMonitoringMessage('Container ' + action + ' completed successfully.');
      }
      await loadMonitoringContainers(monitoringServerId || LOCAL_SERVER_ID, { silent: true });
      if (action !== 'delete') await loadMonitoringDetail(monitoringDetail.id, { silent: true });
      loadAgents();
    } catch (error) {
      const data = error.response?.data;
      setMonitoringMessage(data?.error || data?.output || 'Container action failed.');
    } finally {
      setMonitoringActionLoading(false);
    }
  };

  const handleMonitoringLogs = (container) => {
    loadContainerLogs(
      container.id,
      monitoringServerId || LOCAL_SERVER_ID,
      container.name + ' logs'
    );
  };

  const handleMonitoringTerminal = (container) => {
    if ((monitoringServerId || LOCAL_SERVER_ID) !== LOCAL_SERVER_ID) {
      setMonitoringMessage('Interactive terminal is currently available for containers on the application server.');
      return;
    }
    handleConnectClick(container);
  };

  const handleDashboardNavigate = (target) => {
    if (target === 'running') {
      setContainerServerId(dashboardServerId);
      setContainerTab('existing');
      handleActionSelect(manualActions[0]);
      return;
    }
    if (target === 'stopped') {
      setContainerServerId(dashboardServerId);
      setContainerTab('stopped');
      handleActionSelect(manualActions[0]);
      return;
    }
    if (target === 'deleted') {
      setContainerServerId(dashboardServerId);
      setContainerTab('recyclebin');
      handleActionSelect(manualActions[0]);
      return;
    }
    if (target === 'images') {
      setContainerServerId(dashboardServerId);
      setImageTab('delete');
      handleActionSelect(buildImageAction);
      return;
    }
    if (target === 'volumes') {
      setContainerServerId(dashboardServerId);
      setVolumeTab('delete');
      handleActionSelect(manualActions[3]);
      return;
    }
    if (target === 'networks') {
      setContainerServerId(dashboardServerId);
      setNetworkTab('delete');
      handleActionSelect(manualActions[2]);
      return;
    }
    if (target === 'deployments') {
      setDeploymentServerId(dashboardServerId);
      setDeploymentTab('existing');
      handleActionSelect(deploymentAction);
      return;
    }
    if (target === 'agents') {
      handleActionSelect(agentActions[1]);
      return;
    }
    if (target === 'server-health') {
      handleActionSelect(serverInfoAction);
    }
  };

  const handleContainerResourceNavigate = (target) => {
    if (target === 'running') {
      setContainerTab('existing');
      return;
    }
    if (target === 'stopped') {
      setContainerTab('stopped');
      return;
    }
    if (target === 'deleted') {
      setContainerTab('recyclebin');
      return;
    }
    if (target === 'networks') {
      setNetworkTab('delete');
      handleActionSelect(manualActions[2]);
      return;
    }
    if (target === 'volumes') {
      setVolumeTab('delete');
      handleActionSelect(manualActions[3]);
    }
  };

  const handleStopContainerFromCreate = async () => {
    const targetName = containerName.trim();
    if (!targetName) {
      setContainerMessage('Enter a container name to stop.');
      return;
    }

    setContainerLoading(true);
    setContainerMessage('');
    setContainerCreateOutput(`Stopping container ${targetName}...\n`);

    try {
      const response = await authService.containerAction(targetName, 'stop', getSelectedDockerServerId());
      const outputLines = [
        response.data.command ? `$ ${response.data.command}` : '',
        response.data.output || '',
        response.data.success ? `Container ${targetName} stopped successfully.` : '',
      ].filter(Boolean);
      setContainerCreateOutput(outputLines.join('\n'));
      setContainerMessage(`Container ${targetName} stopped successfully.`);
      loadAgents();
      if (containerTab === 'existing') {
        loadContainers(getSelectedDockerServerId());
      }
    } catch (error) {
      const data = error.response?.data;
      const message = data?.error || data?.output || `Failed to stop ${targetName}.`;
      setContainerCreateOutput(message);
      setContainerMessage(message);
    } finally {
      setContainerLoading(false);
    }
  };

  const stopShellPolling = () => {
    if (shellOutputTimerRef.current) {
      clearInterval(shellOutputTimerRef.current);
      shellOutputTimerRef.current = null;
    }
  };

  const closeActiveShellSession = async () => {
    stopShellPolling();

    const sessionId = shellSessionIdRef.current;
    shellSessionIdRef.current = null;
    setShellSessionId(null);

    if (sessionId) {
      try {
        await authService.closeShellSession(sessionId);
      } catch (error) {
        // The backend may already have closed the process.
      }
    }
  };

  const stopVolumeShellPolling = () => {
    if (volumeShellOutputTimerRef.current) {
      clearInterval(volumeShellOutputTimerRef.current);
      volumeShellOutputTimerRef.current = null;
    }
  };

  const closeActiveVolumeShellSession = async () => {
    stopVolumeShellPolling();

    const sessionId = volumeShellSessionIdRef.current;
    volumeShellSessionIdRef.current = null;
    setVolumeShellSessionId(null);

    if (sessionId) {
      try {
        await authService.closeShellSession(sessionId);
      } catch (error) {
        // The backend may already have closed the process.
      }
    }
  };

  const handleConnectClick = async (containerOverride = null) => {
    const targetContainer = containerOverride?.id ? {
      ID: containerOverride.id,
      Names: ['/' + (containerOverride.name || 'container')],
    } : selectedContainer;
    if (!targetContainer) return;
    const selectedContainerId = targetContainer.ID || targetContainer.Id || targetContainer.id;
    const selectedContainerName = targetContainer.Names?.[0]?.replace(/^\//, '') || 'container';

    if (!selectedContainerId) {
      setConnectMessage('Container ID is missing.');
      return;
    }

    setConnectLoading(true);
    setConnectTarget({ type: 'container', key: selectedContainerId });
    setConnectMessage('');
    await closeActiveShellSession();
    setActiveShellContainer(null);
    setShellOutput('');

    try {
      const response = await authService.connectContainer(selectedContainerId);
      const data = response.data;
      
      if (data.success) {
        shellSessionIdRef.current = data.session_id;
        setShellSessionId(data.session_id);
        setShellOutput(data.output);
        setActiveShellContainer({
          id: data.container_id || selectedContainerId,
          name: data.container_name || selectedContainerName,
          prompt: data.terminal_prompt || '',
          kind: 'container',
          usesNativePrompt: true,
        });
        setConnectModalOpen(true);
        setTimeout(() => shellInputRef.current?.focus(), 0);
        
        stopShellPolling();
        const timer = setInterval(() => {
          pollShellOutput(data.session_id);
        }, 500);
        shellOutputTimerRef.current = timer;
      } else {
        setConnectMessage(data.error || 'Failed to start shell.');
      }
    } catch (error) {
      const data = error.response?.data;
      setConnectMessage(data?.error || 'Failed to connect to container.');
    } finally {
      setConnectLoading(false);
      setConnectTarget(null);
    }
  };

  const pollShellOutput = async (sessionId) => {
    try {
      const response = await authService.getShellOutput(sessionId);
      const data = response.data;
      
      if (data.output) {
        setShellOutput((prev) => prev + data.output);
      }
      
      if (data.status === 'process_ended') {
        stopShellPolling();
        shellSessionIdRef.current = null;
        setShellSessionId(null);
      }
    } catch (error) {
      // Silently handle polling errors
    }
  };

  const pollVolumeShellOutput = async (sessionId) => {
    try {
      const response = await authService.getShellOutput(sessionId);
      const data = response.data;

      if (data.output) {
        setVolumeShellOutput((prev) => prev + data.output);
      }

      if (data.status === 'process_ended') {
        stopVolumeShellPolling();
        volumeShellSessionIdRef.current = null;
        setVolumeShellSessionId(null);
      }
    } catch (error) {
      // Silently handle polling errors
    }
  };

  const handleSendShellCommand = async (event) => {
    event.preventDefault();
    if (!shellSessionId || !shellInput.trim()) return;
    const command = shellInput.trim();

    if (command === 'clear' || command === 'cls') {
      setShellOutput('');
      setShellInput('');
      setTimeout(() => shellInputRef.current?.focus(), 0);
      return;
    }
    
    setShellInputLoading(true);
    
    try {
      await authService.sendShellCommand(shellSessionId, shellInput);
      setShellInput('');
    } catch (error) {
      setConnectMessage('Failed to send command.');
    } finally {
      setShellInputLoading(false);
      setTimeout(() => shellInputRef.current?.focus(), 0);
    }
  };

  const handleSendVolumeShellCommand = async (event) => {
    event.preventDefault();
    if (!volumeShellSessionId || !volumeShellInput.trim()) return;
    const command = volumeShellInput.trim();

    if (command === 'clear' || command === 'cls') {
      setVolumeShellOutput('');
      setVolumeShellInput('');
      setTimeout(() => volumeShellInputRef.current?.focus(), 0);
      return;
    }

    setVolumeShellInputLoading(true);

    try {
      await authService.sendShellCommand(volumeShellSessionId, volumeShellInput);
      setVolumeShellInput('');
    } catch (error) {
      setConnectMessage('Failed to send command.');
    } finally {
      setVolumeShellInputLoading(false);
      setTimeout(() => volumeShellInputRef.current?.focus(), 0);
    }
  };

  const handleCloseVolumeShell = async () => {
    await closeActiveVolumeShellSession();
    setVolumeConnectModalOpen(false);
    setActiveVolumeShell(null);
    setVolumeShellOutput('');
    setVolumeShellInput('');
  };

  const handleCloseShell = async () => {
    await closeActiveShellSession();
    setConnectModalOpen(false);
    setActiveShellContainer(null);
    setShellOutput('');
    setShellInput('');
  };

  const handleConnectVolumeClick = async (mount) => {
    if (!selectedContainer || !mount) return;
    const selectedContainerId = selectedContainer.ID || selectedContainer.Id || selectedContainer.id;
    const volumeLabel = mount.Name || mount.Source || mount.Destination || 'volume';
    const selectedContainerName = getContainerName(selectedContainer);
    const volumeKey = getMountConnectKey(mount);

    setConnectLoading(true);
    setConnectTarget({ type: 'volume', key: volumeKey });
    setConnectMessage('');
    await closeActiveVolumeShellSession();
    setActiveVolumeShell(null);
    setVolumeShellOutput('');

    try {
      const response = await authService.connectVolume({
        container_id: selectedContainerId,
        source: mount.Source || '',
        name: mount.Name || '',
        destination: mount.Destination || '',
        server_id: getSelectedDockerServerId(),
      });
      const data = response.data;

      if (data.success) {
        volumeShellSessionIdRef.current = data.session_id;
        setVolumeShellSessionId(data.session_id);
        setVolumeShellOutput(data.output || "");
        setActiveVolumeShell({
          id: data.temporary_container || data.session_id,
          name: data.volume_name || volumeLabel,
          containerName: data.container_name || selectedContainerName,
          path: data.terminal_path || data.volume_destination || '/',
          prompt: data.terminal_prompt || '/ #',
          kind: 'volume',
          usesNativePrompt: true,
        });
        setVolumeConnectModalOpen(true);
        setTimeout(() => volumeShellInputRef.current?.focus(), 0);

        stopVolumeShellPolling();
        const timer = setInterval(() => {
          pollVolumeShellOutput(data.session_id);
        }, 500);
        volumeShellOutputTimerRef.current = timer;
      } else {
        setConnectMessage(data.error || 'Failed to start volume terminal.');
      }
    } catch (error) {
      const data = error.response?.data;
      setConnectMessage(data?.error || 'Failed to connect to volume.');
    } finally {
      setConnectLoading(false);
      setConnectTarget(null);
    }
  };


  const buildVolumeGuiPayload = (volumeContext, path = '') => {
    const mount = volumeContext?.mount;
    if (!volumeContext || !mount) return null;
    return {
      container_id: volumeContext.containerId,
      source: mount.Source || '',
      name: mount.Name || '',
      destination: mount.Destination || '',
      path,
      server_id: volumeContext.serverId || '',
    };
  };

  const loadVolumeGuiPath = async (path = volumeGuiPath, volumeContext = activeVolumeGui) => {
    const payload = buildVolumeGuiPayload(volumeContext, path);
    if (!payload) return;

    setVolumeGuiLoading(true);
    setVolumeGuiMessage('');
    try {
      const response = await authService.listVolumeFiles(payload);
      const data = response.data;
      setVolumeGuiPath(data.path || '');
      setVolumeGuiEntries(data.entries || []);
      if (data.volume_name || data.container_name || data.display_path) {
        setActiveVolumeGui((previous) => previous ? {
          ...previous,
          name: data.volume_name || previous.name,
          containerName: data.container_name || previous.containerName,
          displayPath: data.display_path || previous.displayPath,
        } : previous);
      }
    } catch (error) {
      const data = error.response?.data;
      setVolumeGuiMessage(data?.error || 'Failed to open volume GUI.');
    } finally {
      setVolumeGuiLoading(false);
    }
  };

  const handleConnectVolumeGuiClick = async (mount) => {
    if (!selectedContainer || !mount) return;
    const selectedContainerId = selectedContainer.ID || selectedContainer.Id || selectedContainer.id;
    const volumeKey = getMountConnectKey(mount);
    const context = {
      containerId: selectedContainerId,
      containerName: getContainerName(selectedContainer),
      name: mount.Name || mount.Source || mount.Destination || 'volume',
      mount,
      serverId: getSelectedDockerServerId(),
    };

    setConnectLoading(true);
    setConnectTarget({ type: 'volume-gui', key: volumeKey });
    setConnectMessage('');
    setActiveVolumeGui(context);
    setVolumeGuiPath('');
    setVolumeGuiEntries([]);
    setVolumeGuiMessage('');
    setVolumeGuiModalOpen(true);

    try {
      await loadVolumeGuiPath('', context);
    } finally {
      setConnectLoading(false);
      setConnectTarget(null);
    }
  };

  const handleCloseVolumeGui = () => {
    setVolumeGuiModalOpen(false);
    setActiveVolumeGui(null);
    setVolumeGuiPath('');
    setVolumeGuiEntries([]);
    setVolumeGuiMessage('');
    handleCloseVolumeFilePreview();
  };

  const runVolumeGuiAction = async (action, path, extra = {}, refreshPath = volumeGuiPath) => {
    const payload = buildVolumeGuiPayload(activeVolumeGui, path);
    if (!payload) return;

    setVolumeGuiLoading(true);
    setVolumeGuiMessage('');
    try {
      await authService.volumeFileAction({ ...payload, action, ...extra });
      await loadVolumeGuiPath(refreshPath, activeVolumeGui);
    } catch (error) {
      const data = error.response?.data;
      setVolumeGuiMessage(data?.error || 'Volume file operation failed.');
      setVolumeGuiLoading(false);
    }
  };

  const handleVolumeGuiOpenEntry = (entry) => {
    const targetPath = joinVolumeGuiPath(volumeGuiPath, entry.name);
    if (entry.type === 'directory') {
      loadVolumeGuiPath(targetPath);
      return;
    }
    handleVolumeGuiPreview(entry);
  };

  const handleVolumeGuiPreview = async (entry) => {
    const targetPath = joinVolumeGuiPath(volumeGuiPath, entry.name);
    const payload = buildVolumeGuiPayload(activeVolumeGui, targetPath);
    if (!payload) return;

    setVolumeFilePreviewLoading(true);
    setVolumeFilePreviewMessage('');
    setVolumeFilePreview(null);
    try {
      const response = await authService.downloadVolumeFile(payload);
      setVolumeFilePreview(buildVolumeFilePreview({
        filename: response.data.filename || entry.name,
        path: targetPath,
        size: entry.size,
        contentBase64: response.data.content_base64 || '',
      }));
    } catch (error) {
      const data = error.response?.data;
      setVolumeFilePreviewMessage(data?.error || 'Failed to open file.');
    } finally {
      setVolumeFilePreviewLoading(false);
    }
  };

  const handleCloseVolumeFilePreview = () => {
    setVolumeFilePreview(null);
    setVolumeFilePreviewMessage('');
    setVolumeFilePreviewLoading(false);
  };

  const handleVolumeGuiDownload = async (entry) => {
    const targetPath = joinVolumeGuiPath(volumeGuiPath, entry.name);
    const payload = buildVolumeGuiPayload(activeVolumeGui, targetPath);
    if (!payload) return;

    setVolumeGuiLoading(true);
    setVolumeGuiMessage('');
    try {
      const response = await authService.downloadVolumeFile(payload);
      downloadBase64File(response.data.filename || entry.name, response.data.content_base64 || '');
    } catch (error) {
      const data = error.response?.data;
      setVolumeGuiMessage(data?.error || 'Failed to download file.');
    } finally {
      setVolumeGuiLoading(false);
    }
  };

  const handleVolumeGuiNewFolder = () => {
    const folderName = window.prompt('Folder name');
    if (!folderName) return;
    if (folderName.includes('/') || folderName.includes('\\')) {
      setVolumeGuiMessage('Folder name cannot contain path separators.');
      return;
    }
    runVolumeGuiAction('mkdir', joinVolumeGuiPath(volumeGuiPath, folderName));
  };

  const handleVolumeGuiRename = (entry) => {
    const nextName = window.prompt('Rename to', entry.name);
    if (!nextName || nextName === entry.name) return;
    if (nextName.includes('/') || nextName.includes('\\')) {
      setVolumeGuiMessage('Name cannot contain path separators.');
      return;
    }
    runVolumeGuiAction(
      'rename',
      joinVolumeGuiPath(volumeGuiPath, entry.name),
      { new_path: joinVolumeGuiPath(volumeGuiPath, nextName) }
    );
  };

  const handleVolumeGuiDelete = (entry) => {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    runVolumeGuiAction('delete', joinVolumeGuiPath(volumeGuiPath, entry.name));
  };

  const handleVolumeGuiUploadClick = () => {
    volumeGuiFileInputRef.current?.click();
  };

  const handleVolumeGuiFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setVolumeGuiLoading(true);
    setVolumeGuiMessage('');
    try {
      const contentBase64 = await readFileAsBase64(file);
      await authService.volumeFileAction({
        ...buildVolumeGuiPayload(activeVolumeGui, joinVolumeGuiPath(volumeGuiPath, file.name)),
        action: 'write_file',
        content_base64: contentBase64,
      });
      await loadVolumeGuiPath(volumeGuiPath, activeVolumeGui);
    } catch (error) {
      const data = error.response?.data;
      setVolumeGuiMessage(data?.error || 'Failed to upload file.');
      setVolumeGuiLoading(false);
    }
  };

  const handleAttachNetwork = async (networkId) => {
    if (!selectedContainer) return;
    setContainerActionLoading(true);

    try {
      await authService.attachNetwork(
        selectedContainer.ID || selectedContainer.Id || selectedContainer.id,
        networkId,
        getSelectedDockerServerId()
      );
      setContainerActionMessage('Network attached successfully.');
      handleSelectContainer(selectedContainer);
      setTimeout(() => setContainerActionMessage(''), 3000);
    } catch (error) {
      const data = error.response?.data;
      setContainerActionMessage(data?.error || data?.output || 'Failed to attach network.');
    } finally {
      setContainerActionLoading(false);
    }
  };

  const handleDetachNetwork = async (networkId) => {
    if (!selectedContainer) return;
    setContainerActionLoading(true);

    try {
      await authService.detachNetwork(
        selectedContainer.ID || selectedContainer.Id || selectedContainer.id,
        networkId,
        getSelectedDockerServerId()
      );
      setContainerActionMessage('Network detached successfully.');
      handleSelectContainer(selectedContainer);
      setTimeout(() => setContainerActionMessage(''), 3000);
    } catch (error) {
      const data = error.response?.data;
      setContainerActionMessage(data?.error || data?.output || 'Failed to detach network.');
    } finally {
      setContainerActionLoading(false);
    }
  };

  const modalDragStartsOnControl = (event) => Boolean(
    event.target.closest('button, input, select, textarea, a, label, [data-no-modal-drag]')
  );

  const handleConnectModalDragStart = (event) => {
    if (modalDragStartsOnControl(event)) return;
    setConnectModalDrag({
      startX: event.clientX - connectModalPosition.x,
      startY: event.clientY - connectModalPosition.y,
    });
  };

  const handleVolumeConnectModalDragStart = (event) => {
    if (modalDragStartsOnControl(event)) return;
    setVolumeConnectModalDrag({
      startX: event.clientX - volumeConnectModalPosition.x,
      startY: event.clientY - volumeConnectModalPosition.y,
    });
  };

  const handleVolumeGuiModalDragStart = (event) => {
    if (modalDragStartsOnControl(event)) return;
    setVolumeGuiModalDrag({
      startX: event.clientX - volumeGuiModalPosition.x,
      startY: event.clientY - volumeGuiModalPosition.y,
    });
  };

  useEffect(() => {
    if (!connectModalDrag) return;

    const handleMouseMove = (event) => {
      setConnectModalPosition({
        x: event.clientX - connectModalDrag.startX,
        y: event.clientY - connectModalDrag.startY,
      });
    };

    const handleMouseUp = () => {
      setConnectModalDrag(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [connectModalDrag]);

  useEffect(() => {
    if (!volumeConnectModalDrag) return;

    const handleMouseMove = (event) => {
      setVolumeConnectModalPosition({
        x: event.clientX - volumeConnectModalDrag.startX,
        y: event.clientY - volumeConnectModalDrag.startY,
      });
    };

    const handleMouseUp = () => {
      setVolumeConnectModalDrag(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [volumeConnectModalDrag]);

  useEffect(() => {
    if (!volumeGuiModalDrag) return;

    const handleMouseMove = (event) => {
      setVolumeGuiModalPosition({
        x: event.clientX - volumeGuiModalDrag.startX,
        y: event.clientY - volumeGuiModalDrag.startY,
      });
    };

    const handleMouseUp = () => {
      setVolumeGuiModalDrag(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [volumeGuiModalDrag]);

  useEffect(() => {
    if (!isDeploymentDetailApiPath(location.pathname)) return;

    setActiveAction(deploymentAction);
    setDeploymentTab('existing');
    loadDeployments();
    if (redirectedDeploymentId) {
      setSelectedDeploymentId(redirectedDeploymentId);
      setDeploymentDetail(null);
      loadDeploymentDetail(redirectedDeploymentId);
    }
    navigate('/deployment', { replace: true });
  }, [location.pathname, location.search]);

  const handleBuildImage = async (event) => {
    event.preventDefault();
    setBuildMessage('');
    setBuildOutput('Starting Docker image build...\n');
    setBuildJobId('');
    localStorage.removeItem(BUILD_JOB_STORAGE_KEY);
    setBuildLoading(true);

    try {
      const response = await authService.buildImage(imageName, dockerfilePath);
      setBuildJobId(response.data.job_id);
      localStorage.setItem(BUILD_JOB_STORAGE_KEY, response.data.job_id);
      setBuildOutput(response.data.output || 'Starting Docker image build...\n');
      setBuildMessage('Image build is running. Open output to watch progress.');
      if (imageTab === 'delete') {
        loadImages();
      }
    } catch (error) {
      const data = error.response?.data;
      setBuildOutput(data?.output || data?.error || error.message || 'Docker image build failed.');
      setBuildMessage(data?.error || 'Image build failed. Open output for details.');
      setBuildJobId('');
      localStorage.removeItem(BUILD_JOB_STORAGE_KEY);
      setBuildLoading(false);
    }
  };

  const handleSelectedImageChange = (image) => {
    setSelectedImages((current) => toggleSelectedItem(current, image, getImageId));
  };

  const handleConfirmDeleteImage = () => {
    if (selectedImages.length === 0) {
      return;
    }

    setImageDeleteMessage('');
    setPendingDeleteImages(selectedImages);
  };

  const handleRejectDeleteImage = () => {
    setPendingDeleteImages([]);
  };

  const handleAcceptDeleteImage = async () => {
    if (pendingDeleteImages.length === 0) {
      return;
    }

    const imagesToDelete = pendingDeleteImages;
    setImageDeleteLoading(true);
    setImageDeleteMessage('');

    const results = await Promise.allSettled(
      imagesToDelete.map((image) =>
        authService.deleteImage({
          name: getImageReference(image),
          id: getImageId(image),
        })
      )
    );
    const failed = results
      .map((result, index) => ({ result, image: imagesToDelete[index] }))
      .filter(({ result }) => result.status === 'rejected');

    setPendingDeleteImages([]);
    setSelectedImages([]);
    await loadImages();
    setImageDeleteLoading(false);

    if (failed.length) {
      setImageDeleteMessage(formatImageDeleteFailureMessage(results.length - failed.length, failed));
      return;
    }

    setImageDeleteMessage(`Deleted ${results.length} image(s) successfully.`);
  };

  const handleStopBuild = async () => {
    if (!buildJobId) {
      return;
    }

    setBuildMessage('Stopping image build...');

    try {
      const response = await authService.stopBuildImage(buildJobId);
      setBuildOutput(response.data.output || 'Stopping Docker image build...\n');
      setBuildLoading(Boolean(response.data.running));
      if (!response.data.running) {
        localStorage.removeItem(BUILD_JOB_STORAGE_KEY);
        setBuildMessage('Image build stopped.');
      }
    } catch (error) {
      const data = error.response?.data;
      setBuildMessage(data?.error || 'Unable to stop image build.');
    }
  };

  const handleCreateNetwork = async (event) => {
    event.preventDefault();
    setNetworkMessage('');
    setNetworkLoading(true);

    try {
      const response = await authService.createNetwork({
        name: networkName,
        driver: networkDriver,
      });
      const output = response.data.output ? ` ${response.data.output}` : '';
      setNetworkMessage(`Network created successfully.${output}`);
      setNetworkName('');
      setNetworkDriver('bridge');
      if (networkTab === 'delete') {
        loadNetworks();
      }
    } catch (error) {
      const data = error.response?.data;
      setNetworkMessage(data?.error || data?.output || 'Unable to create network.');
    } finally {
      setNetworkLoading(false);
    }
  };

  const handleSelectedNetworkChange = (network) => {
    setSelectedNetworks((current) => toggleSelectedItem(current, network, getNetworkId));
  };

  const handleConfirmDeleteNetwork = () => {
    if (selectedNetworks.length === 0) {
      return;
    }

    setNetworkDeleteMessage('');
    setPendingDeleteNetworks(selectedNetworks);
  };

  const handleRejectDeleteNetwork = () => {
    setPendingDeleteNetworks([]);
  };

  const handleAcceptDeleteNetwork = async () => {
    if (pendingDeleteNetworks.length === 0) {
      return;
    }

    const networksToDelete = pendingDeleteNetworks;
    setNetworkDeleteLoading(true);
    setNetworkDeleteMessage('');

    const results = await Promise.allSettled(
      networksToDelete.map((network) =>
        authService.deleteNetwork({
          name: getNetworkName(network),
          id: getNetworkId(network),
        })
      )
    );
    const failed = results
      .map((result, index) => ({ result, network: networksToDelete[index] }))
      .filter(({ result }) => result.status === 'rejected');

    setPendingDeleteNetworks([]);
    setSelectedNetworks([]);
    await loadNetworks();
    setNetworkDeleteLoading(false);

    if (failed.length) {
      setNetworkDeleteMessage(formatNetworkDeleteFailureMessage(results.length - failed.length, failed));
      return;
    }

    setNetworkDeleteMessage(`Deleted ${results.length} network(s) successfully.`);
  };

  const handleCreateVolume = async (event) => {
    event.preventDefault();
    setVolumeMessage('');
    setVolumeLoading(true);

    try {
      const response = await authService.createVolume({
        name: volumeName,
        driver: volumeDriver,
      });
      const output = response.data.output ? ` ${response.data.output}` : '';
      setVolumeMessage(`Volume created successfully.${output}`);
      setVolumeName('');
      setVolumeDriver('local');
      if (volumeTab === 'delete') {
        loadVolumes();
      }
    } catch (error) {
      const data = error.response?.data;
      setVolumeMessage(data?.error || data?.output || 'Unable to create volume.');
    } finally {
      setVolumeLoading(false);
    }
  };

  const handleSelectedVolumeChange = (volume) => {
    setSelectedVolumes((current) => toggleSelectedItem(current, volume, getVolumeName));
  };

  const handleConfirmDeleteVolume = () => {
    if (selectedVolumes.length === 0) {
      return;
    }

    setVolumeDeleteMessage('');
    setPendingDeleteVolumes(selectedVolumes);
  };

  const handleRejectDeleteVolume = () => {
    setPendingDeleteVolumes([]);
  };

  const handleAcceptDeleteVolume = async () => {
    if (pendingDeleteVolumes.length === 0) {
      return;
    }

    const volumesToDelete = pendingDeleteVolumes;
    setVolumeDeleteLoading(true);
    setVolumeDeleteMessage('');

    const results = await Promise.allSettled(
      volumesToDelete.map((volume) => authService.deleteVolume(getVolumeName(volume)))
    );
    const failed = results
      .map((result, index) => ({ result, volume: volumesToDelete[index] }))
      .filter(({ result }) => result.status === 'rejected');

    setPendingDeleteVolumes([]);
    setSelectedVolumes([]);
    await loadVolumes();
    setVolumeDeleteLoading(false);

    if (failed.length) {
      setVolumeDeleteMessage(formatVolumeDeleteFailureMessage(results.length - failed.length, failed));
      return;
    }

    setVolumeDeleteMessage(`Deleted ${results.length} volume(s) successfully.`);
  };

  const handleOutputModalDragStart = (event) => {
    if (modalDragStartsOnControl(event)) return;
    setOutputModalDrag({
      startX: event.clientX,
      startY: event.clientY,
      initialX: outputModalPosition.x,
      initialY: outputModalPosition.y,
    });
  };

  useEffect(() => {
    if (!outputModalDrag) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      setOutputModalPosition({
        x: outputModalDrag.initialX + event.clientX - outputModalDrag.startX,
        y: outputModalDrag.initialY + event.clientY - outputModalDrag.startY,
      });
    };

    const handlePointerUp = () => {
      setOutputModalDrag(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [outputModalDrag]);

  const loadFileBrowser = async (path = '') => {
    setFileBrowserLoading(true);
    setFileBrowserError('');

    try {
      const response = await authService.browseDockerfiles(path);
      setFileBrowserData(response.data);
    } catch (error) {
      const data = error.response?.data;
      setFileBrowserError(data?.error || 'Unable to load server folders.');
      if (data?.current_path) {
        setFileBrowserData(data);
      }
    } finally {
      setFileBrowserLoading(false);
    }
  };

  const openFileBrowser = () => {
    setFileBrowserOpen(true);
    loadFileBrowser(dockerfilePath);
  };

  const openContainerFileBrowser = () => {
    setFileBrowserOpen(true);
    loadFileBrowser(containerDockerfilePath);
  };

  const loadComposeBrowser = async (path = '') => {
    setComposeBrowserLoading(true);
    setComposeBrowserError('');

    try {
      const response = await authService.browseComposeFiles(path);
      setComposeBrowserData(response.data);
    } catch (error) {
      const data = error.response?.data;
      setComposeBrowserError(data?.error || 'Unable to load server folders.');
      if (data?.current_path) {
        setComposeBrowserData(data);
      }
    } finally {
      setComposeBrowserLoading(false);
    }
  };

  const openComposeBrowser = () => {
    setComposeBrowserOpen(true);
    loadComposeBrowser(composeFilePath);
  };

  const loadDeployments = async () => {
    setDeploymentsLoading(true);
    setDeploymentsError('');

    try {
      const response = await authService.listDeployments();
      setDeployments(response.data.deployments || []);
    } catch (error) {
      const data = error.response?.data;
      setDeployments([]);
      setDeploymentsError(data?.error || data?.output || 'Unable to load deployments.');
    } finally {
      setDeploymentsLoading(false);
    }
  };

  const loadDeploymentDetail = async (deploymentId = selectedDeploymentId) => {
    if (!deploymentId) return;
    setDeploymentDetailLoading(true);
    setDeploymentActionMessage('');

    try {
      const response = await authService.getDeploymentDetail(deploymentId, {
        browser_hostname: window.location.hostname,
      });
      setDeploymentDetail(response.data);
    } catch (error) {
      const data = error.response?.data;
      setDeploymentDetail(null);
      setDeploymentActionMessage(data?.error || 'Unable to load deployment details.');
    } finally {
      setDeploymentDetailLoading(false);
    }
  };

  const handleSelectDeployment = (deploymentId, event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setSelectedDeploymentId(deploymentId);
    setDeploymentDetail(null);
    if (deploymentId) {
      loadDeploymentDetail(deploymentId);
    }
  };

  const handleDeployApplication = async (event) => {
    event.preventDefault();
    setDeploymentMessage('');
    setDeploymentOutput('Starting Docker Compose deployment...\n');
    setDeploymentJobId('');
    localStorage.removeItem(DEPLOY_JOB_STORAGE_KEY);
    setDeploymentLoading(true);

    try {
      const response = await authService.createDeployment({
        name: deploymentName,
        compose_file: composeFilePath,
        server_id: deploymentServerId || LOCAL_SERVER_ID,
      });
      setDeploymentJobId(response.data.job_id);
      localStorage.setItem(DEPLOY_JOB_STORAGE_KEY, response.data.job_id);
      setDeploymentOutput(response.data.output || 'Starting Docker Compose deployment...\n');
      setDeploymentMessage('Deployment is running. Open output to watch progress.');
      await loadDeployments();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentOutput(data?.output || data?.error || error.message || 'Deployment failed.');
      setDeploymentMessage(data?.error || 'Deployment failed. Open output for details.');
      setDeploymentJobId('');
      localStorage.removeItem(DEPLOY_JOB_STORAGE_KEY);
      setDeploymentLoading(false);
    }
  };

  const handleStopDeployment = async () => {
    if (!deploymentJobId) return;
    setDeploymentMessage('Stopping deployment...');

    try {
      const response = await authService.stopDeployment(deploymentJobId);
      setDeploymentOutput(response.data.output || 'Stopping deployment...\n');
      setDeploymentLoading(Boolean(response.data.running));
      if (!response.data.running) {
        localStorage.removeItem(DEPLOY_JOB_STORAGE_KEY);
        setDeploymentMessage('Deployment stopped.');
      }
    } catch (error) {
      const data = error.response?.data;
      setDeploymentMessage(data?.error || 'Unable to stop deployment.');
    }
  };

  const handleDeleteDeployment = async () => {
    if (!selectedDeploymentId) return;
    const selectedDeployment = deployments.find((deployment) => String(deployment.id) === String(selectedDeploymentId))
      || deploymentDetail?.deployment
      || null;
    const deploymentName = selectedDeployment?.name || 'this deployment';
    if (!window.confirm('Are you sure want to delete "' + deploymentName + '"?')) return;

    setDeploymentActionLoading(true);
    setDeploymentActionMessage('');

    try {
      await authService.deleteDeployment(selectedDeploymentId);
      setDeploymentActionMessage('Deployment deleted successfully.');
      setSelectedDeploymentId('');
      setDeploymentDetail(null);
      await loadDeployments();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentActionMessage(data?.output || data?.error || 'Unable to delete deployment.');
    } finally {
      setDeploymentActionLoading(false);
    }
  };

  const getSelectedDeploymentServerId = () => {
    const detailAgentId = deploymentDetail?.deployment?.target_agent?.id;
    const selectedAgentId = deployments.find((deployment) => String(deployment.id) === String(selectedDeploymentId))?.target_agent?.id;
    return detailAgentId || selectedAgentId || LOCAL_SERVER_ID;
  };

  const handleRestartDeployment = async () => {
    const deploymentContainers = deploymentDetail?.containers || [];
    if (!deploymentContainers.length) return;

    setDeploymentActionLoading(true);
    setDeploymentActionMessage('');
    try {
      const serverId = getSelectedDeploymentServerId();
      const results = await Promise.allSettled(
        deploymentContainers
          .map((container) => getDeploymentContainerId(container))
          .filter(Boolean)
          .map((containerId) => authService.containerAction(containerId, 'restart', serverId))
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        const data = failed[0].reason?.response?.data;
        setDeploymentActionMessage(data?.error || data?.output || `Restarted ${results.length - failed.length} container(s), ${failed.length} failed.`);
      } else {
        setDeploymentActionMessage('Deployment restarted successfully.');
      }
      await loadDeploymentDetail();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentActionMessage(data?.error || data?.output || 'Failed to restart deployment.');
    } finally {
      setDeploymentActionLoading(false);
    }
  };

  const handleDeploymentContainerAction = async (container, action) => {
    const containerId = getDeploymentContainerId(container);
    if (!containerId) return;
    setDeploymentActionLoading(true);
    setDeploymentActionMessage('');

    try {
      await authService.containerAction(containerId, action, getSelectedDeploymentServerId());
      setDeploymentActionMessage(`Container ${action} completed.`);
      await loadDeploymentDetail();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentActionMessage(data?.error || data?.output || `Failed to ${action} container.`);
    } finally {
      setDeploymentActionLoading(false);
    }
  };

  const handleDeploymentConnect = async (container) => {
    const containerId = getDeploymentContainerId(container);
    const containerName = container?.name || 'container';
    if (!containerId) return;

    setConnectLoading(true);
    setConnectTarget({ type: 'deployment-container', key: containerId });
    setConnectMessage('');
    await closeActiveShellSession();
    setActiveShellContainer(null);
    setShellOutput('');

    try {
      const response = await authService.connectContainer(containerId);
      const data = response.data;
      if (data.success) {
        shellSessionIdRef.current = data.session_id;
        setShellSessionId(data.session_id);
        setShellOutput(data.output);
        setActiveShellContainer({
          id: data.container_id || containerId,
          name: data.container_name || containerName,
          prompt: data.terminal_prompt || '',
          kind: 'container',
          usesNativePrompt: true,
        });
        setConnectModalOpen(true);
        setTimeout(() => shellInputRef.current?.focus(), 0);

        stopShellPolling();
        const timer = setInterval(() => {
          pollShellOutput(data.session_id);
        }, 500);
        shellOutputTimerRef.current = timer;
      } else {
        setConnectMessage(data.error || 'Failed to start shell.');
      }
    } catch (error) {
      const data = error.response?.data;
      setConnectMessage(data?.error || 'Failed to connect to container.');
    } finally {
      setConnectLoading(false);
      setConnectTarget(null);
    }
  };

  const handleDeploymentLogs = async (container) => {
    const containerId = getDeploymentContainerId(container);
    if (!containerId) return;
    loadContainerLogs(containerId, getSelectedDeploymentServerId(), (container.name || containerId) + ' logs');
  };

  useEffect(() => {
    if (!containerLogOutputOpen || !containerLogTarget) {
      return undefined;
    }

    const refreshTimer = window.setInterval(() => {
      loadContainerLogs(containerLogTarget.id, containerLogTarget.serverId, containerLogTarget.title);
    }, 2500);

    return () => window.clearInterval(refreshTimer);
  }, [containerLogOutputOpen, containerLogTarget?.id, containerLogTarget?.serverId]);

  const handleDeploymentNetworkChange = async (container, networkName, mode) => {
    const containerId = getDeploymentContainerId(container);
    if (!containerId || !networkName) return;
    setDeploymentActionLoading(true);
    setDeploymentActionMessage('');

    try {
      if (mode === 'attach') {
        await authService.attachNetwork(containerId, networkName, getSelectedDeploymentServerId());
        setDeploymentActionMessage('Network attached successfully.');
      } else {
        await authService.detachNetwork(containerId, networkName, getSelectedDeploymentServerId());
        setDeploymentActionMessage('Network detached successfully.');
      }
      await loadDeploymentDetail();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentActionMessage(data?.error || data?.output || 'Network change failed.');
    } finally {
      setDeploymentActionLoading(false);
    }
  };

  const handleDeploymentVolumeChange = async (container, volumeName, mode) => {
    const containerId = getDeploymentContainerId(container);
    if (!containerId || !volumeName) return;
    setDeploymentActionLoading(true);
    setDeploymentActionMessage('');

    try {
      if (mode === 'attach') {
        await authService.attachVolume(containerId, volumeName);
        setDeploymentActionMessage('Volume change requested.');
      } else {
        await authService.detachVolume(containerId, volumeName);
        setDeploymentActionMessage('Volume removal requested.');
      }
      await loadDeploymentDetail();
    } catch (error) {
      const data = error.response?.data;
      setDeploymentActionMessage(data?.error || data?.output || 'Volume change failed.');
    } finally {
      setDeploymentActionLoading(false);
    }
  };

  useEffect(() => {
    if (isDeploymentActive) {
      loadDeployments();
      loadNetworks();
      loadVolumes();
    }
  }, [isDeploymentActive]);

  const loadRegistryImages = async () => {
    setRegistryImagesLoading(true);
    setRegistryImagesError('');
    try {
      const response = await authService.listRegistryImages();
      setRegistryImages(response.data.images || []);
    } catch (error) {
      const data = error.response?.data;
      setRegistryImages([]);
      setRegistryImagesError(data?.error || 'Unable to load registry images.');
    } finally {
      setRegistryImagesLoading(false);
    }
  };

  useEffect(() => {
    if (!isRegistryActive) return;
    loadAgents();
    loadRegistryImages();
  }, [isRegistryActive]);

  const handleDeployRegistryImage = async (event) => {
    event.preventDefault();
    setRegistryDeployLoading(true);
    setRegistryDeployMessage('');
    setRegistryDeployOutput('Creating registry deployment job...');

    try {
      const response = await authService.deployRegistryImage({
        agent_id: registryAgentId,
        image_id: registryImageId,
        container_name: registryContainerName,
        run_args: registryRunArgs,
        registry_username: registryUsername,
        registry_password: registryPassword,
      });
      const job = response.data.job;
      setRegistryDeployOutput(job ? `Job ${job.id} queued for ${job.agent?.name || 'agent'}\nImage: ${job.image_reference}\nContainer: ${job.container_name}\nStatus: ${job.status}` : 'Deployment job queued.');
      setRegistryDeployMessage('Deployment job queued. The agent polls every 30 seconds.');
      setRegistryContainerName('');
      setRegistryRunArgs('');
      setRegistryUsername('');
      setRegistryPassword('');
    } catch (error) {
      const data = error.response?.data;
      setRegistryDeployOutput(data?.output || data?.error || error.message || 'Unable to queue deployment job.');
      setRegistryDeployMessage(data?.error || 'Unable to queue deployment job.');
    } finally {
      setRegistryDeployLoading(false);
    }
  };

  useEffect(() => {
    if (!deploymentJobId || !deploymentLoading) {
      return undefined;
    }

    const loadDeploymentOutput = async () => {
      try {
        const response = await authService.getDeploymentOutput(deploymentJobId);
        const data = response.data;
        setDeploymentOutput(data.output || '');

        if (!data.running) {
          setDeploymentLoading(false);
          localStorage.removeItem(DEPLOY_JOB_STORAGE_KEY);
          setDeploymentMessage(
            data.stopped
              ? 'Deployment stopped.'
              : data.success
                ? 'Deployment completed.'
                : 'Deployment failed.'
          );
          await loadDeployments();
          if (selectedDeploymentId) {
            await loadDeploymentDetail(selectedDeploymentId);
          }
        }
      } catch (error) {
        setDeploymentLoading(false);
        localStorage.removeItem(DEPLOY_JOB_STORAGE_KEY);
        setDeploymentMessage('Unable to load deployment output.');
      }
    };

    loadDeploymentOutput();
    const outputTimer = window.setInterval(loadDeploymentOutput, 1500);
    return () => window.clearInterval(outputTimer);
  }, [deploymentJobId, deploymentLoading, selectedDeploymentId]);

  return (
    <div className="home-shell">
      <div className="home-atmosphere" aria-hidden="true" />
      <aside className="home-sidebar">
        <div className="home-sidebar-title">
          <span className="home-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>Container Console</strong>
          <small>Orchestration control plane</small>
        </div>

        <nav className="home-nav" aria-label="Application navigation">
          {renderNavItem(
            dashboardAction,
            isDashboardActive,
            () => handleActionSelect(dashboardAction)
          )}

          <button
            type="button"
            className="home-nav-parent"
            onClick={() => setManualMenuOpen((open) => !open)}
            aria-expanded={manualMenuOpen}
          >
            <span><span className="home-nav-icon" aria-hidden="true">BR</span>Build & Run</span>
            <span aria-hidden="true">{manualMenuOpen ? '^' : 'v'}</span>
          </button>

          {manualMenuOpen && visibleManualActions.map((action) => renderNavItem(
            action,
            activeAction.id === action.id,
            () => handleActionSelect(action)
          ))}

          {canSeeAction(deploymentAction) && renderNavItem(
            deploymentAction,
            isDeploymentActive,
            () => handleActionSelect(deploymentAction)
          )}

          {canSeeAction(registryAction) && renderNavItem(
            registryAction,
            isRegistryActive,
            () => handleActionSelect(registryAction)
          )}

          {canSeeAction(serverInfoAction) && renderNavItem(
            serverInfoAction,
            isServerInfoActive,
            () => handleActionSelect(serverInfoAction)
          )}

          {canSeeAction(rbacAction) && (
            <>
              <button
                type="button"
                className="home-nav-parent"
                onClick={() => setRbacMenuOpen((open) => !open)}
                aria-expanded={rbacMenuOpen}
              >
                <span><span className="home-nav-icon" aria-hidden="true">UA</span>Users & Access</span>
                <span aria-hidden="true">{rbacMenuOpen ? '^' : 'v'}</span>
              </button>

              {rbacMenuOpen && (
                <>
                  {canCreateRbacUser && (
                    <button
                      type="button"
                      className={`home-nav-item nested ${isRbacActive && rbacTab === 'user' ? 'active' : ''}`}
                      onClick={() => {
                        setRbacTab('user');
                        handleActionSelect(rbacAction);
                      }}
                    >
                      <span className="home-nav-icon" aria-hidden="true">NU</span>
                      <span className="home-nav-copy"><span className="home-nav-label">New user</span>
                      <small>Create a login with scoped operations.</small></span>
                    </button>
                  )}
                  {canCreateRbacGroup && (
                    <button
                      type="button"
                      className={`home-nav-item nested ${isRbacActive && rbacTab === 'group' ? 'active' : ''}`}
                      onClick={() => {
                        setRbacTab('group');
                        handleActionSelect(rbacAction);
                      }}
                    >
                      <span className="home-nav-icon" aria-hidden="true">NG</span>
                      <span className="home-nav-copy"><span className="home-nav-label">New group</span>
                      <small>Bundle permissions for reusable access.</small></span>
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {visibleAgentActions.length > 0 && (
            <>
              <button
                type="button"
                className="home-nav-parent"
                onClick={() => setAgentMenuOpen((open) => !open)}
                aria-expanded={agentMenuOpen}
              >
                <span><span className="home-nav-icon" aria-hidden="true">AG</span>Agent</span>
                <span aria-hidden="true">{agentMenuOpen ? '^' : 'v'}</span>
              </button>

              {agentMenuOpen && visibleAgentActions.map((action) => renderNavItem(
                action,
                activeAction.id === action.id,
                () => handleActionSelect(action)
              ))}
            </>
          )}

          {canSeeAction(monitoringAction) && renderNavItem(
            monitoringAction,
            isMonitoringActive,
            () => handleActionSelect(monitoringAction)
          )}
        </nav>

        <button type="button" className="home-logout" onClick={handleLogout}>
          Sign out
        </button>
      </aside>

      <main className="home-main">
        <header className="home-header">
          <div>
            <h1>{activeAction.title}</h1>
            <p>{activeAction.description}</p>
          </div>
          <div className="home-header-actions">
            <button type="button" className="home-user-card" onClick={handleOpenUserProfile}>
              <span className="home-user-avatar" aria-hidden="true">{(user?.name || user?.username || 'U').slice(0, 1).toUpperCase()}</span>
              <span className="home-user-copy"><span>Workspace</span>
              <strong>{user?.name || user?.username || 'Signed-in user'}</strong>
              <small>User Profile</small></span>
            </button>
          </div>
        </header>

        <DashboardBackContext.Provider value={isDashboardActive ? null : handleBackToDashboard}>
          {isDashboardActive ? (
          <DashboardPanel
            dashboardServerId={dashboardServerId}
            onDashboardServerIdChange={setDashboardServerId}
            agents={agents}
            agentsLoading={agentsLoading}
            containers={containers}
            containersLoading={containersLoading}
            containersError={containersError}
            images={images}
            imagesLoading={imagesLoading}
            imagesError={imagesError}
            networks={networks}
            networksLoading={networksLoading}
            networksError={networksError}
            volumes={volumes}
            volumesLoading={volumesLoading}
            volumesError={volumesError}
            deployments={deployments}
            deploymentsLoading={deploymentsLoading}
            recycledContainers={recycledContainers}
            recycledContainersLoading={recycledContainersLoading}
            recycledContainersError={recycledContainersError}
            onRefresh={() => {
              const serverId = dashboardServerId || LOCAL_SERVER_ID;
              loadAgents();
              loadContainers(serverId);
              loadImages(serverId);
              loadNetworks(serverId);
              loadVolumes(serverId);
              loadDeployments();
              loadRecycledContainers();
            }}
            onOpenResource={handleDashboardNavigate}
          />
        ) : isUserProfileActive ? (
          <UserProfilePanel
            user={user}
            currentPassword={currentPassword}
            newPassword={newPassword}
            confirmNewPassword={confirmNewPassword}
            passwordLoading={passwordLoading}
            passwordMessage={passwordMessage}
            onCurrentPasswordChange={setCurrentPassword}
            onNewPasswordChange={setNewPassword}
            onConfirmNewPasswordChange={setConfirmNewPassword}
            onChangePassword={handleChangePassword}
          />
        ) : isRbacActive ? (
          <RbacPanel
            rbacTab={rbacTab}
            rbacData={rbacData}
            rbacLoading={rbacLoading}
            rbacMessage={rbacMessage}
            rbacUsername={rbacUsername}
            rbacPassword={rbacPassword}
            rbacConfirmPassword={rbacConfirmPassword}
            rbacUserGroupId={rbacUserGroupId}
            rbacUserOperations={rbacUserOperations}
            rbacGroupName={rbacGroupName}
            rbacGroupOperations={rbacGroupOperations}
            canCreateRbacUser={canCreateRbacUser}
            canCreateRbacGroup={canCreateRbacGroup}
            onUsernameChange={setRbacUsername}
            onPasswordChange={setRbacPassword}
            onConfirmPasswordChange={setRbacConfirmPassword}
            onUserGroupChange={setRbacUserGroupId}
            onUserOperationsChange={setRbacUserOperations}
            onGroupNameChange={setRbacGroupName}
            onGroupOperationsChange={setRbacGroupOperations}
            onCreateUser={handleCreateRbacUser}
            onCreateGroup={handleCreateRbacGroup}
            onDeleteItem={handleDeleteRbacItem}
            onRefresh={loadRbac}
          />
        ) : isServerInfoActive ? (
          <ServerInfoPanel
            serverInfo={serverInfo}
            loading={serverInfoLoading}
            error={serverInfoError}
            onRefresh={() => loadServerInfo(true)}
          />
        ) : isMonitoringActive ? (
          <MonitoringPanel
            serverId={monitoringServerId}
            onServerIdChange={setMonitoringServerId}
            agents={agents}
            agentsLoading={agentsLoading}
            containers={monitoringContainers}
            loading={monitoringLoading}
            error={monitoringError}
            selectedId={selectedMonitoringId}
            detail={monitoringDetail}
            detailLoading={monitoringDetailLoading}
            history={monitoringHistory}
            actionLoading={monitoringActionLoading}
            message={monitoringMessage}
            onSelect={(containerId) => {
              setSelectedMonitoringId(containerId);
              setMonitoringDetail(null);
              setMonitoringHistory([]);
              setMonitoringMessage('');
            }}
            onRefresh={() => loadMonitoringContainers(monitoringServerId || LOCAL_SERVER_ID)}
            onAction={handleMonitoringAction}
            onLogs={handleMonitoringLogs}
            onTerminal={handleMonitoringTerminal}
            containerLogOutput={containerLogOutput}
            containerLogTitle={containerLogTitle}
            containerLogOutputOpen={containerLogOutputOpen}
            onCloseContainerLogOutput={() => {
              setContainerLogOutputOpen(false);
              setContainerLogTarget(null);
            }}
            outputModalPosition={outputModalPosition}
            onOutputModalDragStart={handleOutputModalDragStart}
            connectModalOpen={connectModalOpen}
            connectModalPosition={connectModalPosition}
            activeShellContainer={activeShellContainer}
            shellSessionId={shellSessionId}
            shellOutput={shellOutput}
            shellInput={shellInput}
            shellInputLoading={shellInputLoading}
            shellInputRef={shellInputRef}
            onShellInputChange={setShellInput}
            onSendShellCommand={handleSendShellCommand}
            onCloseConnectModal={handleCloseShell}
            onConnectModalDragStart={handleConnectModalDragStart}
            canOperate={canOperate}
          />
        ) : isCreateAgentActive || isConnectedAgentActive ? (
          <AgentPanel
            mode={isCreateAgentActive ? 'create' : 'connected'}
            agentName={agentName}
            agentServerIp={agentServerIp}
            agentPort={agentPort}
            agentTab={agentTab}
            agentLoading={agentLoading}
            agentDeleteLoading={agentDeleteLoading}
            agentRedeployLoading={agentRedeployLoading}
            agentMessage={agentMessage}
            agentCreateOutput={agentCreateOutput}
            agentDeleteOutput={agentDeleteOutput}
            agentCreateOutputOpen={agentCreateOutputOpen}
            agentDeleteOutputOpen={agentDeleteOutputOpen}
            outputModalPosition={outputModalPosition}
            agents={agents}
            deletedAgents={deletedAgents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            selectedAgentId={selectedAgentId}
            selectedDeletedAgentId={selectedDeletedAgentId}
            onAgentNameChange={setAgentName}
            onAgentServerIpChange={setAgentServerIp}
            onAgentPortChange={setAgentPort}
            onAgentTabChange={setAgentTab}
            onSelectedAgentChange={setSelectedAgentId}
            onSelectedDeletedAgentChange={setSelectedDeletedAgentId}
            onCreateAgent={handleCreateAgent}
            onDeleteAgent={handleDeleteAgent}
            onRedeployAgent={handleRedeployAgent}
            onRefreshAgents={loadAgents}
            onOpenAgentCreateOutput={() => setAgentCreateOutputOpen(true)}
            onCloseAgentCreateOutput={() => setAgentCreateOutputOpen(false)}
            onOpenAgentDeleteOutput={() => setAgentDeleteOutputOpen(true)}
            onCloseAgentDeleteOutput={() => setAgentDeleteOutputOpen(false)}
            onOutputModalDragStart={handleOutputModalDragStart}
          />
        ) : isContainerActive ? (
          <CreateContainerPanel
            containerName={containerName}
            containerRegistry={containerRegistry}
            containerImageName={containerImageName}
            containerDockerfilePath={containerDockerfilePath}
            containerHostPort={containerHostPort}
            containerPort={containerPort}
            containerNetwork={containerNetwork}
            containerVolume={containerVolume}
            containerVolumeTarget={containerVolumeTarget}
            containerServerId={containerServerId}
            containerAdvancedOpen={containerAdvancedOpen}
            containerLoading={containerLoading}
            containerMessage={containerMessage}
            containerCreateOutput={containerCreateOutput}
            containerOutputOpen={containerOutputOpen}
            registries={CONTAINER_REGISTRIES}
            networks={networks}
            networksLoading={networksLoading}
            volumes={volumes}
            volumesLoading={volumesLoading}
            images={images}
            agents={agents}
            agentsLoading={agentsLoading}
            containerTab={containerTab}
            containers={containers}
            containersLoading={containersLoading}
            containersError={containersError}
            recycledContainers={recycledContainers}
            recycledContainersLoading={recycledContainersLoading}
            recycledContainersError={recycledContainersError}
            restoreContainerTarget={restoreContainerTarget}
            restoreContainerServerId={restoreContainerServerId}
            restoreContainerImage={restoreContainerImage}
            restoreContainerLoading={restoreContainerLoading}
            restoreContainerMessage={restoreContainerMessage}
            deleteRecycledContainerTarget={deleteRecycledContainerTarget}
            deleteRecycledContainerLoading={deleteRecycledContainerLoading}
            deleteRecycledContainerMessage={deleteRecycledContainerMessage}
            selectedContainer={selectedContainer}
            selectedContainerDetail={selectedContainerDetail}
            containerDetailLoading={containerDetailLoading}
            containerActionLoading={containerActionLoading}
            containerActionMessage={containerActionMessage}
            containerLogOutput={containerLogOutput}
            containerLogTitle={containerLogTitle}
            containerLogOutputOpen={containerLogOutputOpen}
            containerInspectOutputOpen={containerInspectOutputOpen}
            containerInspectOutput={containerInspectOutput}
            containerInspectTitle={containerInspectTitle}
            connectModalOpen={connectModalOpen}
            connectModalPosition={connectModalPosition}
            volumeConnectModalPosition={volumeConnectModalPosition}
            volumeGuiModalPosition={volumeGuiModalPosition}
            connectLoading={connectLoading}
            connectTarget={connectTarget}
            connectMessage={connectMessage}
            activeShellContainer={activeShellContainer}
            volumeConnectModalOpen={volumeConnectModalOpen}
            activeVolumeShell={activeVolumeShell}
            volumeGuiModalOpen={volumeGuiModalOpen}
            activeVolumeGui={activeVolumeGui}
            volumeGuiPath={volumeGuiPath}
            volumeGuiEntries={volumeGuiEntries}
            volumeGuiLoading={volumeGuiLoading}
            volumeGuiMessage={volumeGuiMessage}
            volumeFilePreview={volumeFilePreview}
            volumeFilePreviewLoading={volumeFilePreviewLoading}
            volumeFilePreviewMessage={volumeFilePreviewMessage}
            volumeShellSessionId={volumeShellSessionId}
            volumeShellOutput={volumeShellOutput}
            volumeShellInput={volumeShellInput}
            volumeShellInputLoading={volumeShellInputLoading}
            volumeShellInputRef={volumeShellInputRef}
            volumeGuiFileInputRef={volumeGuiFileInputRef}
            shellSessionId={shellSessionId}
            shellOutput={shellOutput}
            shellInput={shellInput}
            shellInputLoading={shellInputLoading}
            shellInputRef={shellInputRef}
            onShellInputChange={setShellInput}
            onVolumeShellInputChange={setVolumeShellInput}
            onSendShellCommand={handleSendShellCommand}
            onSendVolumeShellCommand={handleSendVolumeShellCommand}
            onContainerNameChange={setContainerName}
            onContainerRegistryChange={setContainerRegistry}
            onContainerImageNameChange={setContainerImageName}
            onContainerDockerfilePathChange={setContainerDockerfilePath}
            onContainerHostPortChange={setContainerHostPort}
            onContainerPortChange={setContainerPort}
            onContainerNetworkChange={setContainerNetwork}
            onContainerVolumeChange={setContainerVolume}
            onContainerVolumeTargetChange={setContainerVolumeTarget}
            onContainerServerIdChange={setContainerServerId}
            onContainerAdvancedOpenChange={setContainerAdvancedOpen}
            onCreateContainer={handleCreateContainer}
            onStopContainerFromCreate={handleStopContainerFromCreate}
            onOpenContainerOutput={() => setContainerOutputOpen(true)}
            onCloseContainerOutput={() => setContainerOutputOpen(false)}
            outputModalPosition={outputModalPosition}
            onOutputModalDragStart={handleOutputModalDragStart}
            onContainerTabChange={setContainerTab}
            onSelectContainer={handleSelectContainer}
            onContainerAction={handleContainerAction}
            onOpenRestoreContainer={handleOpenRestoreContainer}
            onConfirmRestoreContainer={handleConfirmRestoreContainer}
            onCancelRestoreContainer={handleCancelRestoreContainer}
            onRestoreContainerServerIdChange={setRestoreContainerServerId}
            onRestoreContainerImageChange={setRestoreContainerImage}
            onRefreshRecycleBin={loadRecycledContainers}
            onOpenDeleteRecycledContainer={handleOpenDeleteRecycledContainer}
            onConfirmDeleteRecycledContainer={handleConfirmDeleteRecycledContainer}
            onCancelDeleteRecycledContainer={handleCancelDeleteRecycledContainer}
            onOpenResource={handleContainerResourceNavigate}
            onContainerLogs={handleContainerLogs}
            onContainerInspect={handleContainerInspect}
            onCloseContainerInspect={() => setContainerInspectOutputOpen(false)}
            onCloseContainerLogOutput={() => {
              setContainerLogOutputOpen(false);
              setContainerLogTarget(null);
            }}
            onConnectClick={handleConnectClick}
            onConnectVolume={handleConnectVolumeClick}
            onConnectVolumeGui={handleConnectVolumeGuiClick}
            onCloseConnectModal={handleCloseShell}
            onCloseVolumeConnectModal={handleCloseVolumeShell}
            onCloseVolumeGuiModal={handleCloseVolumeGui}
            onAttachNetwork={handleAttachNetwork}
            onDetachNetwork={handleDetachNetwork}
            onConnectModalDragStart={handleConnectModalDragStart}
            onVolumeConnectModalDragStart={handleVolumeConnectModalDragStart}
            onVolumeGuiModalDragStart={handleVolumeGuiModalDragStart}
            onVolumeGuiOpenEntry={handleVolumeGuiOpenEntry}
            onVolumeGuiRefresh={() => loadVolumeGuiPath(volumeGuiPath)}
            onVolumeGuiUp={() => loadVolumeGuiPath(getVolumeGuiParentPath(volumeGuiPath))}
            onVolumeGuiNewFolder={handleVolumeGuiNewFolder}
            onVolumeGuiUploadClick={handleVolumeGuiUploadClick}
            onVolumeGuiFileSelected={handleVolumeGuiFileSelected}
            onVolumeGuiRename={handleVolumeGuiRename}
            onVolumeGuiDelete={handleVolumeGuiDelete}
            onVolumeGuiDownload={handleVolumeGuiDownload}
            onCloseVolumeFilePreview={handleCloseVolumeFilePreview}
            fileBrowserOpen={fileBrowserOpen}
            fileBrowserData={fileBrowserData}
            fileBrowserLoading={fileBrowserLoading}
            fileBrowserError={fileBrowserError}
            onOpenDockerfileBrowser={openContainerFileBrowser}
            onBrowseDockerfilePath={loadFileBrowser}
            onSelectDockerfile={(path) => {
              setContainerDockerfilePath(path);
              setFileBrowserOpen(false);
            }}
            onCloseDockerfileBrowser={() => setFileBrowserOpen(false)}
            canOperate={canOperate}
          />
        ) : isDeploymentActive ? (
          <DeploymentPanel
            deploymentName={deploymentName}
            composeFilePath={composeFilePath}
            deploymentServerId={deploymentServerId}
            deploymentTab={deploymentTab}
            deploymentLoading={deploymentLoading}
            deploymentMessage={deploymentMessage}
            deploymentOutput={deploymentOutput}
            deploymentJobId={deploymentJobId}
            deploymentOutputOpen={deploymentOutputOpen}
            outputModalPosition={outputModalPosition}
            composeBrowserOpen={composeBrowserOpen}
            composeBrowserData={composeBrowserData}
            composeBrowserLoading={composeBrowserLoading}
            composeBrowserError={composeBrowserError}
            deployments={deployments}
            deploymentsLoading={deploymentsLoading}
            deploymentsError={deploymentsError}
            selectedDeploymentId={selectedDeploymentId}
            deploymentDetail={deploymentDetail}
            deploymentDetailLoading={deploymentDetailLoading}
            deploymentActionMessage={deploymentActionMessage}
            deploymentActionLoading={deploymentActionLoading}
            agents={agents}
            agentsLoading={agentsLoading}
            networks={networks}
            volumes={volumes}
            selectedDeploymentNetwork={selectedDeploymentNetwork}
            selectedDeploymentVolume={selectedDeploymentVolume}
            containerLogOutput={containerLogOutput}
            containerLogTitle={containerLogTitle}
            containerLogOutputOpen={containerLogOutputOpen}
            connectModalOpen={connectModalOpen}
            connectModalPosition={connectModalPosition}
            connectLoading={connectLoading}
            connectTarget={connectTarget}
            connectMessage={connectMessage}
            activeShellContainer={activeShellContainer}
            shellSessionId={shellSessionId}
            shellOutput={shellOutput}
            shellInput={shellInput}
            shellInputLoading={shellInputLoading}
            shellInputRef={shellInputRef}
            onDeploymentNameChange={setDeploymentName}
            onComposeFilePathChange={setComposeFilePath}
            onDeploymentServerIdChange={setDeploymentServerId}
            onDeploymentTabChange={setDeploymentTab}
            onDeployApplication={handleDeployApplication}
            onStopDeployment={handleStopDeployment}
            onOpenDeploymentOutput={() => setDeploymentOutputOpen(true)}
            onCloseDeploymentOutput={() => setDeploymentOutputOpen(false)}
            onOutputModalDragStart={handleOutputModalDragStart}
            onOpenComposeBrowser={openComposeBrowser}
            onCloseComposeBrowser={() => setComposeBrowserOpen(false)}
            onBrowseComposePath={loadComposeBrowser}
            onSelectComposeFile={(path) => {
              setComposeFilePath(path);
              setComposeBrowserOpen(false);
            }}
            onRefreshDeployments={loadDeployments}
            onSelectDeployment={handleSelectDeployment}
            onRefreshDeploymentDetail={() => loadDeploymentDetail()}
            onDeleteDeployment={handleDeleteDeployment}
            onRestartDeployment={handleRestartDeployment}
            onDeploymentContainerAction={handleDeploymentContainerAction}
            onDeploymentConnect={handleDeploymentConnect}
            onDeploymentLogs={handleDeploymentLogs}
            onDeploymentNetworkChange={handleDeploymentNetworkChange}
            onDeploymentVolumeChange={handleDeploymentVolumeChange}
            onSelectedDeploymentNetworkChange={setSelectedDeploymentNetwork}
            onSelectedDeploymentVolumeChange={setSelectedDeploymentVolume}
            onCloseContainerLogOutput={() => {
              setContainerLogOutputOpen(false);
              setContainerLogTarget(null);
            }}
            onShellInputChange={setShellInput}
            onSendShellCommand={handleSendShellCommand}
            onCloseConnectModal={handleCloseShell}
            onConnectModalDragStart={handleConnectModalDragStart}
            canOperate={canOperate}
          />
        ) : isRegistryActive ? (
          <RegistryPanel
            agents={agents}
            agentsLoading={agentsLoading}
            images={registryImages}
            imagesLoading={registryImagesLoading}
            imagesError={registryImagesError}
            selectedAgentId={registryAgentId}
            selectedImageId={registryImageId}
            containerName={registryContainerName}
            runArgs={registryRunArgs}
            registryUsername={registryUsername}
            registryPassword={registryPassword}
            deployLoading={registryDeployLoading}
            deployMessage={registryDeployMessage}
            deployOutput={registryDeployOutput}
            onSelectedAgentChange={setRegistryAgentId}
            onSelectedImageChange={setRegistryImageId}
            onContainerNameChange={setRegistryContainerName}
            onRunArgsChange={setRegistryRunArgs}
            onRegistryUsernameChange={setRegistryUsername}
            onRegistryPasswordChange={setRegistryPassword}
            onDeploy={handleDeployRegistryImage}
            onRefreshImages={loadRegistryImages}
            onRefreshAgents={loadAgents}
            canOperate={canOperate}
          />
        ) : isBuildImageActive ? (
          <BuildImagePanel
            imageName={imageName}
            dockerfilePath={dockerfilePath}
            buildLoading={buildLoading}
            buildMessage={buildMessage}
            buildOutput={buildOutput}
            buildJobId={buildJobId}
            imageTab={imageTab}
            images={images}
            imagesLoading={imagesLoading}
            imagesError={imagesError}
            attachmentContainers={monitoringContainers}
            selectedImages={selectedImages}
            pendingDeleteImages={pendingDeleteImages}
            imageDeleteLoading={imageDeleteLoading}
            imageDeleteMessage={imageDeleteMessage}
            outputOpen={outputOpen}
            outputModalPosition={outputModalPosition}
            onImageNameChange={setImageName}
            onDockerfilePathChange={setDockerfilePath}
            onBuildImage={handleBuildImage}
            onStopBuild={handleStopBuild}
            onImageTabChange={setImageTab}
            onRefreshImages={loadImages}
            onClearImageDeleteMessage={() => setImageDeleteMessage('')}
            onSelectedImageChange={handleSelectedImageChange}
            onConfirmDeleteImage={handleConfirmDeleteImage}
            onAcceptDeleteImage={handleAcceptDeleteImage}
            onRejectDeleteImage={handleRejectDeleteImage}
            onOpenOutput={() => setOutputOpen(true)}
            onCloseOutput={() => setOutputOpen(false)}
            onOutputModalDragStart={handleOutputModalDragStart}
            fileBrowserOpen={fileBrowserOpen}
            fileBrowserData={fileBrowserData}
            fileBrowserLoading={fileBrowserLoading}
            fileBrowserError={fileBrowserError}
            onOpenFileBrowser={openFileBrowser}
            onCloseFileBrowser={() => setFileBrowserOpen(false)}
            onBrowsePath={loadFileBrowser}
            onSelectDockerfile={(path) => {
              setDockerfilePath(path);
              setFileBrowserOpen(false);
            }}
            canOperate={canOperate}
          />
        ) : isNetworkActive ? (
          <NetworkPanel
            networkName={networkName}
            networkDriver={networkDriver}
            networkLoading={networkLoading}
            networkMessage={networkMessage}
            networkTab={networkTab}
            networks={networks}
            networksLoading={networksLoading}
            networksError={networksError}
            attachmentContainers={monitoringContainers}
            selectedNetworks={selectedNetworks}
            pendingDeleteNetworks={pendingDeleteNetworks}
            networkDeleteLoading={networkDeleteLoading}
            networkDeleteMessage={networkDeleteMessage}
            onNetworkNameChange={setNetworkName}
            onNetworkDriverChange={setNetworkDriver}
            onCreateNetwork={handleCreateNetwork}
            onNetworkTabChange={setNetworkTab}
            onRefreshNetworks={loadNetworks}
            onClearNetworkDeleteMessage={() => setNetworkDeleteMessage('')}
            onSelectedNetworkChange={handleSelectedNetworkChange}
            onConfirmDeleteNetwork={handleConfirmDeleteNetwork}
            onAcceptDeleteNetwork={handleAcceptDeleteNetwork}
            onRejectDeleteNetwork={handleRejectDeleteNetwork}
            canOperate={canOperate}
          />
        ) : isVolumeActive ? (
          <VolumePanel
            volumeName={volumeName}
            volumeDriver={volumeDriver}
            volumeLoading={volumeLoading}
            volumeMessage={volumeMessage}
            volumeTab={volumeTab}
            volumes={volumes}
            volumesLoading={volumesLoading}
            volumesError={volumesError}
            attachmentContainers={monitoringContainers}
            selectedVolumes={selectedVolumes}
            pendingDeleteVolumes={pendingDeleteVolumes}
            volumeDeleteLoading={volumeDeleteLoading}
            volumeDeleteMessage={volumeDeleteMessage}
            onVolumeNameChange={setVolumeName}
            onVolumeDriverChange={setVolumeDriver}
            onCreateVolume={handleCreateVolume}
            onVolumeTabChange={setVolumeTab}
            onRefreshVolumes={loadVolumes}
            onClearVolumeDeleteMessage={() => setVolumeDeleteMessage('')}
            onSelectedVolumeChange={handleSelectedVolumeChange}
            onConfirmDeleteVolume={handleConfirmDeleteVolume}
            onAcceptDeleteVolume={handleAcceptDeleteVolume}
            onRejectDeleteVolume={handleRejectDeleteVolume}
            canOperate={canOperate}
          />
        ) : (
          <section className="home-panel">
            <h2>{activeAction.title}</h2>
            <p>{activeAction.description}</p>
            <button type="button" className="home-primary-button">
              Open
            </button>
          </section>
          )}
        </DashboardBackContext.Provider>
      </main>
    </div>
  );
}



function parsePercentValue(value) {
  const parsed = Number.parseFloat(String(value || '0').replace('%', ''));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseDockerSize(value) {
  const match = String(value || '0B').trim().match(/^([0-9.]+)\s*([kmgt]?i?b)?$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]) || 0;
  const unit = (match[2] || 'B').toUpperCase();
  const factors = { B: 1, KB: 1000, KIB: 1024, MB: 1000000, MIB: 1048576, GB: 1000000000, GIB: 1073741824, TB: 1000000000000, TIB: 1099511627776 };
  return amount * (factors[unit] || 1);
}

function parseNetworkIOValue(value) {
  const parts = String(value || '').split('/');
  return {
    rx: parseDockerSize(parts[0]),
    tx: parseDockerSize(parts[1]),
  };
}

function formatMonitoringUptime(startedAt, running) {
  if (!running || !startedAt) return 'Not running';
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return 'Unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return days + 'd ' + hours + 'h ' + minutes + 'm';
  if (hours) return hours + 'h ' + minutes + 'm';
  return minutes + 'm ' + (seconds % 60) + 's';
}

function buildChartPoints(values, maxValue) {
  if (!values.length) return '';
  const width = 300;
  const height = 90;
  const ceiling = Math.max(maxValue || 0, ...values, 1);
  return values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - Math.min(value / ceiling, 1) * (height - 8) - 4;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}

function MonitoringChart({ title, value, primaryValues, secondaryValues = [], maxValue = 100, primaryLabel, secondaryLabel }) {
  return (
    <article className="monitoring-chart-card">
      <div className="monitoring-chart-heading">
        <div><span>{title}</span><strong>{value}</strong></div>
        <div className="monitoring-chart-legend">
          {primaryLabel && <span><i className="chart-key primary" />{primaryLabel}</span>}
          {secondaryLabel && <span><i className="chart-key secondary" />{secondaryLabel}</span>}
        </div>
      </div>
      <svg viewBox="0 0 300 90" role="img" aria-label={title + ' recent history'} preserveAspectRatio="none">
        <path className="monitoring-chart-grid" d="M0 22.5H300 M0 45H300 M0 67.5H300" />
        <polyline className="monitoring-chart-line primary" points={buildChartPoints(primaryValues, maxValue)} />
        {secondaryValues.length > 0 && <polyline className="monitoring-chart-line secondary" points={buildChartPoints(secondaryValues, maxValue)} />}
      </svg>
    </article>
  );
}

function ResourceAttachmentIndicator({ attached, label }) {
  return (
    <span className="resource-attachment" title={attached ? 'Attached to a container' : 'Not attached to any container'}>
      <span className={'resource-attachment-dot ' + (attached ? 'attached' : 'detached')} aria-hidden="true" />
      <span>{label}</span>
      <small>{attached ? 'Attached' : 'Not attached'}</small>
    </span>
  );
}

function isImageAttached(image, containers = []) {
  const reference = getImageDisplayName(image);
  const id = String(getImageId(image) || '').replace('sha256:', '');
  return containers.some((container) => {
    const containerImage = String(container.image || '');
    const containerImageId = String(container.image_id || '').replace('sha256:', '');
    return containerImage === reference || (id && id !== 'Unavailable' && containerImageId.startsWith(id));
  });
}

function isNetworkAttached(name, containers = []) {
  return containers.some((container) => (container.networks || []).some((network) => network.name === name));
}

function isVolumeAttached(name, containers = []) {
  return containers.some((container) => (container.mounts || []).some((mount) => mount.type === 'volume' && mount.name === name));
}

function MonitoringPanel({
  serverId,
  onServerIdChange,
  agents,
  agentsLoading,
  containers,
  loading,
  error,
  selectedId,
  detail,
  detailLoading,
  history,
  actionLoading,
  message,
  onSelect,
  onRefresh,
  onAction,
  onLogs,
  onTerminal,
  containerLogOutput,
  containerLogTitle,
  containerLogOutputOpen,
  onCloseContainerLogOutput,
  outputModalPosition,
  onOutputModalDragStart,
  connectModalOpen,
  connectModalPosition,
  activeShellContainer,
  shellSessionId,
  shellOutput,
  shellInput,
  shellInputLoading,
  shellInputRef,
  onShellInputChange,
  onSendShellCommand,
  onCloseConnectModal,
  onConnectModalDragStart,
  canOperate = () => true,
}) {
  const terminalOutputRef = useRef(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const serverOptions = ensureLocalServerOption(agents);
  const selectedServer = serverOptions.find((agent) => String(agent.id) === String(serverId || LOCAL_SERVER_ID)) || serverOptions[0];
  const cpuValues = history.map((sample) => sample.cpu);
  const memoryValues = history.map((sample) => sample.memory);
  const networkRxValues = history.map((sample) => sample.networkRx);
  const networkTxValues = history.map((sample) => sample.networkTx);
  const networkMax = Math.max(...networkRxValues, ...networkTxValues, 1);
  const statusClass = detail?.status === 'running' ? 'attached' : 'detached';
  const healthClass = detail?.health === 'healthy' ? 'attached' : detail?.health === 'unhealthy' ? 'detached' : 'neutral';

  useEffect(() => {
    if (terminalOutputRef.current) terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
  }, [shellOutput, connectModalOpen]);

  useEffect(() => {
    setDeleteConfirmOpen(false);
  }, [detail?.id]);

  return (
    <section className="home-panel monitoring-panel">
      <PanelIntro title="Container Monitoring" description="Cloud-style live visibility for every Docker container on the selected server.">
        <button type="button" className="home-secondary-button" onClick={onRefresh} disabled={loading}>Refresh</button>
      </PanelIntro>

      <div className="monitoring-toolbar">
        <label className="agent-select-field">
          <span>Select Agent</span>
          <select value={serverId || LOCAL_SERVER_ID} onChange={(event) => onServerIdChange(event.target.value === LOCAL_SERVER_ID ? '' : event.target.value)} disabled={agentsLoading || loading}>
            <option value={LOCAL_SERVER_ID}>This application server</option>
            {serverOptions.filter((agent) => agent.id !== LOCAL_SERVER_ID).map((agent) => (
              <option value={agent.id} key={agent.id}>{agent.name} ({agent.server_ip}:{agent.port || 19541})</option>
            ))}
          </select>
        </label>
        <div className="monitoring-server-summary">
          <span className={'resource-attachment-dot ' + (selectedServer?.connected !== false ? 'attached' : 'detached')} />
          <div><strong>{selectedServer?.name || 'Application server'}</strong><small>{containers.length} container(s) discovered</small></div>
        </div>
      </div>

      {error && <p className="container-message error">{error}</p>}
      <div className="monitoring-layout">
        <aside className="monitoring-container-list">
          <div className="monitoring-list-heading"><h3>Containers</h3><span>{containers.length}</span></div>
          {loading ? <p className="resource-empty-state">Loading containers...</p> : containers.length ? containers.map((container) => (
            <button type="button" key={container.id} className={'monitoring-container-row ' + (selectedId === container.id ? 'selected' : '')} onClick={() => onSelect(container.id)}>
              <span className={'resource-attachment-dot ' + (container.running ? 'attached' : 'detached')} />
              <span className="monitoring-container-copy"><strong>{container.name}</strong><small>{container.image}</small></span>
              <span className="monitoring-row-status">{container.status}</span>
            </button>
          )) : <p className="resource-empty-state">No containers found on this server.</p>}
        </aside>

        <div className="monitoring-detail">
          {!selectedId ? (
            <div className="monitoring-empty"><strong>Select a container</strong><span>Live metrics and container information will appear here.</span></div>
          ) : detailLoading && !detail ? (
            <p className="resource-empty-state">Loading monitoring statistics...</p>
          ) : detail ? (
            <>
              <header className="monitoring-detail-header">
                <div><span className="monitoring-eyebrow">Container</span><h2>{detail.name}</h2><p>{detail.image}</p></div>
                <div className="monitoring-live-signals">
                  <span><i className={'resource-attachment-dot ' + statusClass} />{detail.status}</span>
                  <span><i className={'resource-attachment-dot ' + healthClass} />{detail.health.replace('-', ' ')}</span>
                  {detail.running && <span className="monitoring-live-badge">Live</span>}
                </div>
              </header>

              <div className="monitoring-charts">
                <MonitoringChart title="CPU Usage" value={detail.cpu_percent} primaryValues={cpuValues} primaryLabel="CPU" />
                <MonitoringChart title="Memory Usage" value={detail.memory_usage} primaryValues={memoryValues} primaryLabel="Memory" />
                <MonitoringChart title="Network I/O" value={detail.network_io} primaryValues={networkRxValues} secondaryValues={networkTxValues} maxValue={networkMax} primaryLabel="Download" secondaryLabel="Upload" />
              </div>

              <section className="monitoring-information">
                <div className="monitoring-section-heading"><h3>Container Information</h3><span>Updated every 3 seconds</span></div>
                <dl className="monitoring-information-grid">
                  <div><dt>Container Name</dt><dd>{detail.name}</dd></div>
                  <div><dt>Status</dt><dd>{detail.status}</dd></div>
                  <div><dt>Health</dt><dd>{detail.health.replace('-', ' ')}</dd></div>
                  <div><dt>Image</dt><dd>{detail.image}</dd></div>
                  <div><dt>CPU Usage</dt><dd>{detail.cpu_percent}</dd></div>
                  <div><dt>Memory Usage</dt><dd>{detail.memory_usage}</dd></div>
                  <div><dt>Network</dt><dd>{detail.network_io}</dd></div>
                  <div><dt>Uptime</dt><dd>{formatMonitoringUptime(detail.started_at, detail.running)}</dd></div>
                  <div><dt>Restarts</dt><dd>{detail.restarts}</dd></div>
                  <div><dt>IP Address</dt><dd>{detail.ip_address || 'Not assigned'}</dd></div>
                  <div><dt>Created</dt><dd>{detail.created ? new Date(detail.created).toLocaleString() : 'Unavailable'}</dd></div>
                </dl>
              </section>

              {message && <p className="container-message">{message}</p>}
              <div className="monitoring-actions">
                <button type="button" className="home-secondary-button" onClick={() => onLogs(detail)}>Logs</button>
                <button type="button" className="home-secondary-button" onClick={() => onTerminal(detail)} disabled={!detail.running || !canOperate('connect_container')}>Terminal</button>
                <button type="button" className="home-primary-button" onClick={() => onAction('restart')} disabled={!detail.running || actionLoading}>Restart</button>
                {detail.running ? <button type="button" className="home-danger-button" onClick={() => onAction('stop')} disabled={actionLoading}>Stop</button> : <button type="button" className="home-primary-button" onClick={() => onAction('start')} disabled={actionLoading}>Start</button>}
                <button type="button" className="home-danger-button" onClick={() => setDeleteConfirmOpen(true)} disabled={!canOperate('delete_container') || actionLoading}>Delete</button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {deleteConfirmOpen && detail && (
        <div className="output-modal-backdrop" role="presentation">
          <div className="resource-delete-modal" role="dialog" aria-modal="true" aria-labelledby="monitoring-delete-title">
            <h3 id="monitoring-delete-title">Delete {detail.name}?</h3>
            <p>The container will be stopped, preserved, and moved to the container recycle bin.</p>
            <div className="resource-modal-actions">
              <button type="button" className="home-danger-button" onClick={() => { setDeleteConfirmOpen(false); onAction('delete'); }} disabled={actionLoading}>Confirm</button>
              <button type="button" className="home-secondary-button" onClick={() => setDeleteConfirmOpen(false)} disabled={actionLoading}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {containerLogOutputOpen && (
        <div className="output-modal-layer" role="presentation"><div className="output-modal" role="dialog" aria-modal="true" aria-labelledby="monitoring-log-title" style={{ transform: 'translate(' + outputModalPosition.x + 'px, ' + outputModalPosition.y + 'px)' }} onPointerDown={onOutputModalDragStart}>
          <div className="output-modal-heading draggable"><h3 id="monitoring-log-title">{containerLogTitle || 'Container logs'}</h3><span className="live-output-badge">Live</span><button type="button" onClick={onCloseContainerLogOutput} onPointerDown={(event) => event.stopPropagation()}>Close</button></div>
          <pre>{containerLogOutput || 'No output yet.'}</pre>
        </div></div>
      )}

      {connectModalOpen && activeShellContainer && (
        <div className="output-modal-layer" role="presentation"><div className="output-modal connect-modal terminal-modal container-terminal-modal" role="dialog" aria-modal="true" aria-labelledby="monitoring-terminal-title" style={{ left: connectModalPosition.x + 'px', top: connectModalPosition.y + 'px', transform: 'none' }} onPointerDown={onConnectModalDragStart}>
          <div className="output-modal-heading draggable"><h3 id="monitoring-terminal-title">Connected to {activeShellContainer.name}</h3><button type="button" onClick={onCloseConnectModal} onPointerDown={(event) => event.stopPropagation()}>Close</button></div>
          <div className="terminal-banner">connected to {activeShellContainer.name}</div>
          <div className="terminal-output" ref={terminalOutputRef} onClick={() => shellInputRef.current?.focus()} onPointerDown={(event) => event.stopPropagation()}>
            <pre>{shellOutput}</pre>
            {shellSessionId && <form className="terminal-input-form" onSubmit={onSendShellCommand}><input ref={shellInputRef} type="text" className="terminal-input" value={shellInput} onChange={(event) => onShellInputChange(event.target.value)} disabled={shellInputLoading} autoComplete="off" spellCheck="false" aria-label={'Terminal command for ' + activeShellContainer.name} autoFocus /></form>}
          </div>
        </div></div>
      )}
    </section>
  );
}

function DashboardPanel({
  dashboardServerId,
  onDashboardServerIdChange,
  agents,
  agentsLoading,
  containers,
  containersLoading,
  containersError,
  images,
  imagesLoading,
  imagesError,
  networks,
  networksLoading,
  networksError,
  volumes,
  volumesLoading,
  volumesError,
  deployments,
  deploymentsLoading,
  recycledContainers,
  recycledContainersLoading,
  recycledContainersError,
  onRefresh,
  onOpenResource,
}) {
  const serverOptions = ensureLocalServerOption(agents);
  const selectedServer = serverOptions.find((agent) => String(agent.id) === String(dashboardServerId || LOCAL_SERVER_ID)) || serverOptions[0];
  const runningContainers = containers.filter(isContainerRunning);
  const stoppedContainers = containers.filter((container) => !isContainerRunning(container));
  const connectedAgents = agents.filter((agent) => agent.id !== LOCAL_SERVER_ID && agent.connected);
  const totalManagedServers = Math.max(ensureLocalServerOption(agents).length, 1);
  const selectedServerId = String(dashboardServerId || LOCAL_SERVER_ID);
  const deletedContainers = recycledContainers.filter((container) => String(container.target_server_id || container.agent_id || LOCAL_SERVER_ID) === selectedServerId);
  const loading = containersLoading || imagesLoading || networksLoading || volumesLoading || deploymentsLoading || agentsLoading || recycledContainersLoading;
  const errors = [containersError, imagesError, networksError, volumesError, recycledContainersError].filter(Boolean);
  const cards = [
    { key: 'running', title: 'Running Containers', value: runningContainers.length, meta: 'Active workloads', visual: 'containers' },
    { key: 'stopped', title: 'Stopped containers', value: stoppedContainers.length, meta: 'Ready to start', visual: 'stopped' },
    { key: 'deleted', title: 'Deleted Containers', value: deletedContainers.length, meta: 'Recycle bin', visual: 'deleted' },
    { key: 'agents', title: 'Connected Agents', value: connectedAgents.length, meta: `${totalManagedServers} managed server(s)`, visual: 'agents' },
    { key: 'server-health', title: 'Server Health', value: getAgentStatus(selectedServer).label, meta: selectedServer?.hostname || selectedServer?.server_ip || 'Application server', visual: 'health' },
    { key: 'volumes', title: 'Volumes', value: volumes.length, meta: 'Persistent storage', visual: 'volumes' },
    { key: 'networks', title: 'Networks', value: networks.length, meta: 'Connection fabric', visual: 'networks' },
    { key: 'images', title: 'Images', value: images.length, meta: 'Build artifacts', visual: 'images' },
    { key: 'deployments', title: 'Deployments', value: deployments.length, meta: 'Compose applications', visual: 'deployments' },
  ];

  return (
    <section className="home-panel dashboard-panel">
      <PanelIntro
        title="Dashboard"
        description="Select an agent and jump into the exact Docker resource you want to manage."
      >
        <button type="button" className="home-secondary-button" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </PanelIntro>

      <div className="dashboard-toolbar">
        <label className="agent-select-field">
          <span>Select Agent</span>
          <select
            value={dashboardServerId}
            onChange={(event) => onDashboardServerIdChange(event.target.value)}
            disabled={agentsLoading}
          >
            <option value="">This application server (default)</option>
            {serverOptions
              .filter((agent) => agent.id !== LOCAL_SERVER_ID)
              .map((agent) => (
                <option value={agent.id} key={agent.id} disabled={!agent.connected}>
                  {agent.name} ({agent.server_ip}:{agent.port || 19541}) {agent.connected ? '' : '- Down'}
                </option>
              ))}
          </select>
        </label>
        <div className="dashboard-agent-summary">
          <span>{selectedServer?.name || 'Application server'}</span>
          <StatusBadge status={getAgentStatus(selectedServer)} />
        </div>
      </div>

      {errors.length > 0 && <p className="container-message error">{errors[0]}</p>}

      <div className="dashboard-grid">
        {cards.map((card) => (
          <button
            type="button"
            key={card.key}
            className="dashboard-card"
            onClick={() => onOpenResource(card.key)}
          >
            <DashboardVisual type={card.visual} />
            <span>{card.title}</span>
            {loading ? <SkeletonText className="dashboard-value-skeleton" /> : <strong>{card.value}</strong>}
            <small>{card.meta}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardVisual({ type }) {
  const scenes = {
    containers: (
      <>
        <span className="dv-node node-a" />
        <span className="dv-node node-b" />
        <span className="dv-flow flow-a" />
        <span className="dv-container c-a" />
        <span className="dv-container c-b" />
        <span className="dv-pulse green" />
      </>
    ),
    stopped: (
      <>
        <span className="dv-node inactive node-a" />
        <span className="dv-container inactive c-a" />
        <span className="dv-container inactive c-b" />
        <span className="dv-sleep-line line-a" />
        <span className="dv-sleep-line line-b" />
      </>
    ),
    deleted: (
      <>
        <span className="dv-container inactive c-a" />
        <span className="dv-container inactive c-b" />
        <span className="dv-delete-bin" />
        <span className="dv-sleep-line line-b" />
      </>
    ),
    agents: (
      <>
        <span className="dv-server rack-a" />
        <span className="dv-server rack-b" />
        <span className="dv-monitor-ring" />
        <span className="dv-packet packet-a" />
        <span className="dv-packet packet-b" />
      </>
    ),
    health: (
      <>
        <span className="dv-health-core" />
        <span className="dv-heartbeat beat-a" />
        <span className="dv-heartbeat beat-b" />
        <span className="dv-pulse green" />
      </>
    ),
    volumes: (
      <>
        <span className="dv-cylinder cyl-a" />
        <span className="dv-cylinder cyl-b" />
        <span className="dv-cylinder cyl-c" />
        <span className="dv-disk-orbit" />
      </>
    ),
    networks: (
      <>
        <span className="dv-link link-a" />
        <span className="dv-link link-b" />
        <span className="dv-link link-c" />
        <span className="dv-node node-a" />
        <span className="dv-node node-b" />
        <span className="dv-node node-c" />
        <span className="dv-packet packet-a" />
        <span className="dv-packet packet-b" />
      </>
    ),
    images: (
      <>
        <span className="dv-image-layer layer-a" />
        <span className="dv-image-layer layer-b" />
        <span className="dv-image-layer layer-c" />
        <span className="dv-scanline" />
      </>
    ),
    deployments: (
      <>
        <span className="dv-pipeline" />
        <span className="dv-stage stage-a" />
        <span className="dv-stage stage-b" />
        <span className="dv-stage stage-c" />
        <span className="dv-packet packet-a" />
      </>
    ),
  };

  return (
    <div className={'dashboard-visual dashboard-visual-scene ' + type} aria-hidden="true">
      <span className="dv-glow" />
      <span className="dv-grid" />
      {scenes[type] || scenes.containers}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={status.className}>{status.label}</span>;
}

function SkeletonText({ className = '' }) {
  return <span className={`skeleton-line ${className}`} aria-label="Loading" />;
}

function UserProfilePanel({
  user,
  currentPassword,
  newPassword,
  confirmNewPassword,
  passwordLoading,
  passwordMessage,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onConfirmNewPasswordChange,
  onChangePassword,
}) {
  return (
    <section className="home-panel user-profile-panel">
      <PanelIntro
        title="User Profile"
        description={`Welcome ${user?.name || user?.username || 'user'}. Update your password below.`}
      />

      <div className="profile-password-section compact">
        <h3>Change password</h3>
        <form className="user-profile-form" onSubmit={onChangePassword}>
          <div className="agent-form-grid">
            <label>
              <span>Current password</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => onCurrentPasswordChange(event.target.value)}
                autoComplete="current-password"
                disabled={passwordLoading}
              />
            </label>
            <label>
              <span>New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => onNewPasswordChange(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                disabled={passwordLoading}
              />
              <small className="field-help">Use at least 8 characters.</small>
            </label>
            <label>
              <span>Confirm password</span>
              <input
                type="password"
                value={confirmNewPassword}
                onChange={(event) => onConfirmNewPasswordChange(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                disabled={passwordLoading}
              />
            </label>
          </div>

          {passwordMessage && <p className="container-message">{passwordMessage}</p>}

          <div className="container-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={passwordLoading || !currentPassword || !newPassword || !confirmNewPassword}
            >
              {passwordLoading ? 'Updating password...' : 'Update password'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function CreateContainerPanel({
  containerName,
  containerRegistry,
  containerImageName,
  containerDockerfilePath,
  containerHostPort,
  containerPort,
  containerNetwork,
  containerVolume,
  containerVolumeTarget,
  containerServerId,
  containerAdvancedOpen,
  containerLoading,
  containerMessage,
  containerCreateOutput,
  containerOutputOpen,
  registries,
  networks,
  networksLoading,
  volumes,
  volumesLoading,
  images,
  agents,
  agentsLoading,
  containerTab,
  containers,
  containersLoading,
  containersError,
  recycledContainers,
  recycledContainersLoading,
  recycledContainersError,
  restoreContainerTarget,
  restoreContainerServerId,
  restoreContainerImage,
  restoreContainerLoading,
  restoreContainerMessage,
  deleteRecycledContainerTarget,
  deleteRecycledContainerLoading,
  deleteRecycledContainerMessage,
  selectedContainer,
  selectedContainerDetail,
  containerDetailLoading,
  containerActionLoading,
  containerActionMessage,
  containerLogOutput,
  containerLogTitle,
  containerLogOutputOpen,
  containerInspectOutputOpen,
  containerInspectOutput,
  containerInspectTitle,
  connectModalOpen,
  connectModalPosition,
  volumeConnectModalPosition,
  volumeGuiModalPosition,
  connectLoading,
  connectTarget,
  connectMessage,
  activeShellContainer,
  volumeConnectModalOpen,
  activeVolumeShell,
  volumeGuiModalOpen,
  activeVolumeGui,
  volumeGuiPath,
  volumeGuiEntries,
  volumeGuiLoading,
  volumeGuiMessage,
  volumeFilePreview,
  volumeFilePreviewLoading,
  volumeFilePreviewMessage,
  volumeShellSessionId,
  volumeShellOutput,
  volumeShellInput,
  volumeShellInputLoading,
  volumeShellInputRef,
  volumeGuiFileInputRef,
  shellSessionId,
  shellOutput,
  shellInput,
  shellInputLoading,
  shellInputRef,
  onShellInputChange,
  onVolumeShellInputChange,
  onSendShellCommand,
  onSendVolumeShellCommand,
  onContainerNameChange,
  onContainerRegistryChange,
  onContainerImageNameChange,
  onContainerDockerfilePathChange,
  onContainerHostPortChange,
  onContainerPortChange,
  onContainerNetworkChange,
  onContainerVolumeChange,
  onContainerVolumeTargetChange,
  onContainerServerIdChange,
  onContainerAdvancedOpenChange,
  onCreateContainer,
  onStopContainerFromCreate,
  onOpenContainerOutput,
  onCloseContainerOutput,
  outputModalPosition,
  onOutputModalDragStart,
  onContainerTabChange,
  onSelectContainer,
  onContainerAction,
  onOpenRestoreContainer,
  onConfirmRestoreContainer,
  onCancelRestoreContainer,
  onRestoreContainerServerIdChange,
  onRestoreContainerImageChange,
  onRefreshRecycleBin,
  onOpenDeleteRecycledContainer,
  onConfirmDeleteRecycledContainer,
  onCancelDeleteRecycledContainer,
  onOpenResource,
  onContainerLogs,
  onContainerInspect,
  onCloseContainerInspect,
  onConnectVolume,
  onConnectVolumeGui,
  onCloseContainerLogOutput,
  onConnectClick,
  onCloseConnectModal,
  onCloseVolumeConnectModal,
  onCloseVolumeGuiModal,
  onAttachNetwork,
  onDetachNetwork,
  onConnectModalDragStart,
  onVolumeConnectModalDragStart,
  onVolumeGuiModalDragStart,
  onVolumeGuiOpenEntry,
  onVolumeGuiRefresh,
  onVolumeGuiUp,
  onVolumeGuiNewFolder,
  onVolumeGuiUploadClick,
  onVolumeGuiFileSelected,
  onVolumeGuiRename,
  onVolumeGuiDelete,
  onVolumeGuiDownload,
  onCloseVolumeFilePreview,
  fileBrowserOpen,
  fileBrowserData,
  fileBrowserLoading,
  fileBrowserError,
  onOpenDockerfileBrowser,
  onBrowseDockerfilePath,
  onSelectDockerfile,
  onCloseDockerfileBrowser,
  canOperate = () => true,
}) {
  const terminalOutputRef = useRef(null);
  const volumeTerminalOutputRef = useRef(null);
  const networkOptions = ensureBridgeNetwork(networks);
  const serverOptions = ensureLocalServerOption(agents);
  const selectedServer = serverOptions.find((agent) => String(agent.id) === String(containerServerId || LOCAL_SERVER_ID)) || serverOptions[0];
  const selectedTargetServerDown = selectedServer?.id !== LOCAL_SERVER_ID && selectedServer && !selectedServer.connected;
  const targetServerUnavailableMessage = 'Target Server agent is deleted or stopped please check it otherwise go to create agent --> delete agent option --> Select existing agent and click on redeploy agent button.';
  const containerName_ = selectedContainer?.Names?.[0]?.replace(/^\//, '') || 'Unknown';
  const terminalContainerName = activeShellContainer?.name || containerName_;
  const terminalPath = activeShellContainer?.path || "/";
  const terminalTitle = activeShellContainer?.kind === "volume" ? "Connected to volume" : "Connected to " + terminalContainerName;
  const terminalPrompt = activeShellContainer?.kind === "volume" ? (activeShellContainer?.prompt || (terminalPath + " #")) : ("root@" + terminalContainerName + ":" + terminalPath + "#");
  const volumeGuiDisplayPath = activeVolumeGui?.displayPath || ('/' + (volumeGuiPath || ''));
  const containerStatus = selectedContainer?.Status || 'Unknown';
  const containerImage = selectedContainer?.Image || 'Unknown';
  const isDockerfileSource = containerRegistry === 'dockerfile';
  const canCreateContainer = canOperate('create_container');
  const canDeleteContainer = canOperate('delete_container');
  const canConnectContainer = canOperate('connect_container');
  const canCreateNetwork = canOperate('create_network');
  const canDeleteNetwork = canOperate('delete_network');
  const runningContainers = containers.filter(isContainerRunning);
  const stoppedContainers = containers.filter((container) => !isContainerRunning(container));
  const selectedServerId = String(containerServerId || LOCAL_SERVER_ID);
  const selectedServerRecycledContainers = recycledContainers.filter(
    (container) => String(container.target_server_id || container.agent_id || LOCAL_SERVER_ID) === selectedServerId
  );
  const displayedContainers = containerTab === 'stopped' ? stoppedContainers : runningContainers;
  const selectedIsRunning = selectedContainer ? isContainerRunning(selectedContainer) : false;
  const selectedContainerPortLabels = selectedContainerDetail ? getDeploymentContainerPortLabels(selectedContainerDetail) : [];
  const selectedContainerAccessUrls = selectedContainerDetail ? getDeploymentContainerAccessUrls(selectedContainerDetail) : [];

  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [shellOutput, connectModalOpen]);

  useEffect(() => {
    if (volumeTerminalOutputRef.current) {
      volumeTerminalOutputRef.current.scrollTop = volumeTerminalOutputRef.current.scrollHeight;
    }
  }, [volumeShellOutput, volumeConnectModalOpen]);

  const getContainerNetworkNames = (container) =>
    (container.networks || []).map((network) => network.name).filter(Boolean);

  const getContainerVolumeNames = (container) =>
    (container.mounts || [])
      .filter((mount) => mount.type === 'volume')
      .map((mount) => mount.name)
      .filter(Boolean);

  const getAvailableNetworkOptions = (container) => {
    const attached = new Set(getContainerNetworkNames(container));
    return networks.filter((network) => !attached.has(getNetworkName(network)));
  };

  const getAvailableVolumeOptions = (container) => {
    const attached = new Set(getContainerVolumeNames(container));
    return volumes.filter((volume) => !attached.has(getVolumeName(volume)));
  };

  return (
    <section className="home-panel container-panel">
      <PanelIntro
        title="Containers"
        description="Create new containers or manage containers already running on the selected server."
      />
      
      <div className="resource-tabs" role="tablist" aria-label="Container actions">
        <button
          type="button"
          role="tab"
          aria-selected={containerTab === 'create'}
          className={containerTab === 'create' ? 'active' : ''}
          onClick={() => onContainerTabChange('create')}
        >
          New container
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={containerTab === 'existing'}
          className={containerTab === 'existing' ? 'active' : ''}
          onClick={() => onContainerTabChange('existing')}
          disabled={containerTab === 'existing'}
        >
          Running containers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={containerTab === 'stopped'}
          className={containerTab === 'stopped' ? 'active' : ''}
          onClick={() => onContainerTabChange('stopped')}
          disabled={containerTab === 'stopped'}
        >
          Stopped containers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={containerTab === 'recyclebin'}
          className={containerTab === 'recyclebin' ? 'active' : ''}
          onClick={() => onContainerTabChange('recyclebin')}
          disabled={containerTab === 'recyclebin'}
        >
          Container recycle bin
        </button>
      </div>

      {containerTab === 'create' && canCreateContainer ? (
        <form className="container-form" onSubmit={onCreateContainer}>
          {selectedTargetServerDown ? (
            <p className="container-message error">{targetServerUnavailableMessage}</p>
          ) : (
            <div className="resource-dashboard compact">
              <article className="resource-stat-card">
                <span>Target</span>
                <strong>{selectedServer?.name || 'Application server'}</strong>
              </article>
              <article className="resource-stat-card">
                <span>Containers</span>
                <strong>{selectedServer?.containers_count ?? 0}</strong>
              </article>
              <article className="resource-stat-card">
                <span>Images</span>
                <strong>{selectedServer?.images_count ?? 0}</strong>
              </article>
              <article className="resource-stat-card">
                <span>Status</span>
                <StatusBadge status={getAgentStatus(selectedServer)} />
              </article>
            </div>
          )}

          <div className="container-field-group">
            <label className="agent-select-field">
              <span>Select Agent</span>
              <select
                value={containerServerId}
                onChange={(event) => onContainerServerIdChange(event.target.value)}
                disabled={containerLoading || agentsLoading}
              >
                <option value="">This application server (default)</option>
                {serverOptions
                  .filter((agent) => agent.id !== LOCAL_SERVER_ID)
                  .map((agent) => (
                    <option value={agent.id} key={agent.id}>
                      {agent.name} ({agent.server_ip}:{agent.port || 19541})
                    </option>
                  ))}
              </select>
              <small className="field-help">
                {agentsLoading ? 'Loading available servers...' : 'Leave empty to create on this application server.'}
              </small>
            </label>

            <label>
              <span>Container name</span>
              <input
                type="text"
                value={containerName}
                onChange={(event) => onContainerNameChange(event.target.value)}
                placeholder="example: web-app"
                disabled={containerLoading}
              />
            </label>
          </div>

          <div className="container-field-group">
            <label>
              <span>Image source</span>
              <select
                value={containerRegistry}
                onChange={(event) => onContainerRegistryChange(event.target.value)}
                disabled={containerLoading}
              >
                {registries.map((registry) => (
                  <option value={registry.id} key={registry.id}>
                    {registry.label} - {registry.endpoint}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>{isDockerfileSource ? 'Image tag' : 'Image name'}</span>
              <input
                type="text"
                value={containerImageName}
                onChange={(event) => onContainerImageNameChange(event.target.value)}
                placeholder={isDockerfileSource ? 'example: my-app:latest' : 'example: nginx:latest'}
                disabled={containerLoading}
              />
            </label>
          </div>

          {isDockerfileSource && (
            <label>
              <span>Dockerfile path</span>
              <div className="path-picker-row">
                <input
                  type="text"
                  value={containerDockerfilePath}
                  onChange={(event) => onContainerDockerfilePathChange(event.target.value)}
                  placeholder="/home/vitel/vitel-container/Dockerfile"
                  disabled={containerLoading}
                />
                <button
                  type="button"
                  className="home-secondary-button"
                  onClick={onOpenDockerfileBrowser}
                  disabled={containerLoading}
                >
                  Browse
                </button>
              </div>
            </label>
          )}

          <div className="container-port-row">
            <label>
              <span>Host port</span>
              <input
                type="text"
                value={containerHostPort}
                onChange={(event) => onContainerHostPortChange(event.target.value)}
                placeholder="8080"
                disabled={containerLoading}
              />
            </label>
            <span className="port-arrow" aria-hidden="true">to</span>
            <label>
              <span>Container port</span>
              <input
                type="text"
                value={containerPort}
                onChange={(event) => onContainerPortChange(event.target.value)}
                placeholder="80"
                disabled={containerLoading}
              />
            </label>
          </div>

          <div className="container-default-network">
            <span>Default network</span>
            <strong>{containerNetwork || 'bridge'}</strong>
          </div>

          <button
            type="button"
            className="advanced-toggle"
            onClick={() => onContainerAdvancedOpenChange((open) => !open)}
            aria-expanded={containerAdvancedOpen}
          >
            {containerAdvancedOpen ? 'Hide advanced settings' : 'Show advanced settings'}
          </button>

          {containerAdvancedOpen && (
            <div className="advanced-settings">
              <label>
                <span>Mount volume</span>
                <select
                  value={containerVolume}
                  onChange={(event) => onContainerVolumeChange(event.target.value)}
                  disabled={containerLoading || volumesLoading}
                >
                  <option value="">No volume attached</option>
                  {volumes.map((volume) => {
                    const name = getVolumeName(volume);
                    return (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    );
                  })}
                </select>
              </label>

              {containerVolume && (
                <label>
                  <span>Volume mount path</span>
                  <input
                    type="text"
                    value={containerVolumeTarget}
                    onChange={(event) => onContainerVolumeTargetChange(event.target.value)}
                    placeholder="/data"
                    disabled={containerLoading}
                  />
                </label>
              )}

              <label>
                <span>Container network</span>
                <select
                  value={containerNetwork}
                  onChange={(event) => onContainerNetworkChange(event.target.value)}
                  disabled={containerLoading || networksLoading}
                >
                  {networkOptions.map((network) => {
                    const name = getNetworkName(network);
                    return (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
          )}

          {containerMessage && <p className="container-message">{containerMessage}</p>}

          <div className="container-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={!canCreateContainer || containerLoading || selectedTargetServerDown || !containerImageName.trim() || (isDockerfileSource && !containerDockerfilePath.trim())}
            >
              {containerLoading ? 'Creating container...' : 'Create container'}
            </button>
            <button
              type="button"
              className="home-danger-button"
              onClick={onStopContainerFromCreate}
              disabled={!canDeleteContainer || containerLoading || !containerName.trim()}
            >
              Stop Container
            </button>
            <button
              type="button"
              className="home-secondary-button"
              onClick={onOpenContainerOutput}
            >
              View output
            </button>
          </div>

          {fileBrowserOpen && (
            <FileBrowserModal
              data={fileBrowserData}
              loading={fileBrowserLoading}
              error={fileBrowserError}
              onBrowsePath={onBrowseDockerfilePath}
              onSelectDockerfile={onSelectDockerfile}
              onClose={onCloseDockerfileBrowser}
            />
          )}
        </form>
      ) : (
        <div className="existing-container-panel">
          <label className="agent-select-field">
            <span>Select Agent</span>
            <select
              value={containerServerId}
              onChange={(event) => onContainerServerIdChange(event.target.value)}
              disabled={containersLoading || agentsLoading}
            >
              <option value="">This application server (default)</option>
              {serverOptions
                .filter((agent) => agent.id !== LOCAL_SERVER_ID)
                .map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name} ({agent.server_ip}:{agent.port || 19541})
                  </option>
                ))}
            </select>
          </label>

          {selectedTargetServerDown ? (
            <p className="container-message error">{targetServerUnavailableMessage}</p>
          ) : (
            <div className="resource-dashboard compact container-resource-shortcuts">
              <button
                type="button"
                className="resource-stat-card resource-stat-button"
                onClick={() => onOpenResource('running')}
                disabled={containerTab === 'existing'}
              >
                <span>Running</span>
                <strong>{runningContainers.length}</strong>
              </button>
              <button
                type="button"
                className="resource-stat-card resource-stat-button"
                onClick={() => onOpenResource('stopped')}
                disabled={containerTab === 'stopped'}
              >
                <span>Stopped</span>
                <strong>{stoppedContainers.length}</strong>
              </button>
              <button
                type="button"
                className="resource-stat-card resource-stat-button"
                onClick={() => onOpenResource('deleted')}
                disabled={containerTab === 'recyclebin'}
              >
                <span>Deleted</span>
                <strong>{selectedServerRecycledContainers.length}</strong>
              </button>
              <button type="button" className="resource-stat-card resource-stat-button" onClick={() => onOpenResource('networks')}>
                <span>Networks</span>
                <strong>{networks.length}</strong>
              </button>
              <button type="button" className="resource-stat-card resource-stat-button" onClick={() => onOpenResource('volumes')}>
                <span>Volumes</span>
                <strong>{volumes.length}</strong>
              </button>
            </div>
          )}

          {containersError && !selectedTargetServerDown && containerTab !== 'recyclebin' && <p className="build-message error">{containersError}</p>}
          {recycledContainersError && containerTab === 'recyclebin' && <p className="build-message error">{recycledContainersError}</p>}
          
          {containerTab === 'recyclebin' ? (
            recycledContainersLoading ? (
              <p className="resource-empty-state">Loading container recycle bin...</p>
            ) : selectedServerRecycledContainers.length > 0 ? (
              <div className="containers-list">
                <div className="resource-delete-toolbar">
                  <p>{selectedServerRecycledContainers.length} deleted container(s) available to restore.</p>
                  <button type="button" className="home-secondary-button" onClick={onRefreshRecycleBin} disabled={recycledContainersLoading}>
                    Refresh
                  </button>
                </div>
                <div className="agent-grid">
                  {selectedServerRecycledContainers.map((container) => (
                    <article className="agent-card" key={container.id}>
                      <div className="agent-card-heading">
                        <h3>{container.container_name}</h3>
                        <span className="agent-status down">Deleted</span>
                      </div>
                      <dl>
                        <div>
                          <dt>Deleted from</dt>
                          <dd>{container.source_label || container.agent_name || 'Application server'}</dd>
                        </div>
                        <div>
                          <dt>Agent IP</dt>
                          <dd>{container.agent_server_ip || 'Local server'}</dd>
                        </div>
                        <div>
                          <dt>Image</dt>
                          <dd>{container.image || 'Unknown'}</dd>
                        </div>
                        <div>
                          <dt>Deleted at</dt>
                          <dd>{container.created_at ? new Date(container.created_at).toLocaleString() : 'Unknown'}</dd>
                        </div>
                      </dl>
                      <div className="agent-card-actions recycle-bin-card-actions">
                        <button
                          type="button"
                          className="home-primary-button"
                          onClick={() => onOpenRestoreContainer(container)}
                          disabled={!canCreateContainer || restoreContainerLoading || deleteRecycledContainerLoading}
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          className="home-danger-button"
                          onClick={() => onOpenDeleteRecycledContainer(container)}
                          disabled={!canDeleteContainer || restoreContainerLoading || deleteRecycledContainerLoading}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="resource-empty-state">No deleted containers in the recycle bin.</p>
            )
          ) : selectedTargetServerDown ? null : containersLoading ? (
            <p className="resource-empty-state">Loading containers...</p>
          ) : displayedContainers.length > 0 ? (
            <div>
              <div className="containers-list">
                <h3>{containerTab === 'stopped' ? 'Choose a stopped container to start' : 'Choose a running container to manage'}</h3>
                <div className="containers-grid">
                  {displayedContainers.map((container) => {
                    const id = getContainerId(container);
                    const name = container.Names?.[0]?.replace(/^\//, '') || 'Unknown';
                    const isSelected = selectedContainer?.ID === id || selectedContainer?.Id === id || selectedContainer?.id === id;
                    
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`container-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => onSelectContainer(container)}
                      >
                        <div className="container-item-image">{container.Image}</div>
                        <div className="container-item-status">{container.Status}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedContainer && (
                <div className="selected-container-details">
                  <h3>Container details</h3>
                  <div className="container-info">
                    <dl>
                      <div>
                        <dt>Name</dt>
                        <dd>{containerName_}</dd>
                      </div>
                      <div>
                        <dt>ID</dt>
                        <dd>{selectedContainer.ID?.substring(0, 12) || 'Unknown'}</dd>
                      </div>
                      <div>
                        <dt>Image</dt>
                        <dd>{containerImage}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{containerStatus}</dd>
                      </div>
                      {selectedIsRunning && selectedContainerDetail && (
                        <div>
                          <dt>Ports</dt>
                          <dd>{selectedContainerPortLabels.join(', ') || 'None'}</dd>
                        </div>
                      )}
                      {selectedIsRunning && selectedContainerDetail && (
                        <div>
                          <dt>Application access URL</dt>
                          <dd className="deployment-url-list">
                            {selectedContainerAccessUrls.length ? (
                              selectedContainerAccessUrls.map((item) => (
                                <a href={item.url} target="_blank" rel="noreferrer" key={item.url}>
                                  {item.url}
                                </a>
                              ))
                            ) : 'None'}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>

                  {containerActionMessage && (
                    <p className="container-message">{containerActionMessage}</p>
                  )}

                  <div className="container-action-buttons">
                    {selectedIsRunning ? (
                      <>
                        <button
                          type="button"
                          className="home-danger-button"
                          onClick={() => onContainerAction('stop')}
                          disabled={containerActionLoading || containerDetailLoading}
                        >
                          {containerActionLoading ? 'Stopping...' : 'Stop container'}
                        </button>
                        <button
                          type="button"
                          className="home-primary-button"
                          onClick={() => onContainerAction('restart')}
                          disabled={containerActionLoading || containerDetailLoading}
                        >
                          {containerActionLoading ? 'Restarting...' : 'Restart container'}
                        </button>
                        <button
                          type="button"
                          className="home-secondary-button"
                          onClick={onConnectClick}
                          disabled={!canConnectContainer || containerDetailLoading || connectLoading}
                        >
                          {connectLoading && connectTarget?.type === 'container' ? 'Opening terminal...' : 'Open terminal'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="home-primary-button"
                        onClick={() => onContainerAction('start')}
                        disabled={containerActionLoading || containerDetailLoading}
                      >
                        {containerActionLoading ? 'Starting...' : 'Start container'}
                      </button>
                    )}
                    {selectedIsRunning && (
                      <button
                        type="button"
                        className="home-secondary-button"
                        onClick={onContainerInspect}
                        disabled={containerDetailLoading || !selectedContainerDetail}
                      >
                        Inspect
                      </button>
                    )}
                    <button
                      type="button"
                      className="home-secondary-button"
                      onClick={onContainerLogs}
                      disabled={containerDetailLoading}
                    >
                      Container logs
                    </button>
                    <button
                      type="button"
                      className="home-danger-button"
                      onClick={() => onContainerAction('delete')}
                      disabled={!canDeleteContainer || containerActionLoading || containerDetailLoading}
                    >
                      {containerActionLoading ? 'Deleting...' : 'Delete container'}
                    </button>
                  </div>

                  {selectedContainerDetail && (
                    <div className="container-networks-volumes">
                      {/* Networks Section */}
                      {selectedContainerDetail.NetworkSettings?.Networks && Object.keys(selectedContainerDetail.NetworkSettings.Networks).length > 0 && (
                        <div className="container-section">
                          <h4>Connected networks</h4>
                          <div className="networks-list">
                            {Object.entries(selectedContainerDetail.NetworkSettings.Networks).map(([netName, netData]) => (
                              <div key={netName} className="network-item">
                                <span>{netName}</span>
                                <button
                                  type="button"
                                  className="home-danger-button"
                                  onClick={() => onDetachNetwork(netName)}
                                  disabled={!canDeleteNetwork || containerActionLoading}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Volumes Section */}
                      {selectedContainerDetail.Mounts && selectedContainerDetail.Mounts.length > 0 && (
                        <div className="container-section">
                          <h4>Mounted volumes</h4>
                          <div className="volumes-list">
                            {selectedContainerDetail.Mounts.map((mount, idx) => (
                              <div key={idx} className="volume-item">
                                <div className="volume-info">
                                  <span className="volume-source">{mount.Source || mount.Name}</span>
                                  <span className="volume-arrow">→</span>
                                  <span className="volume-target">{mount.Destination}</span>
                                </div>
                                {selectedIsRunning && (
                                  <div className="volume-actions">
                                    <button
                                      type="button"
                                      className="home-secondary-button"
                                      onClick={() => onConnectVolumeGui(mount)}
                                      disabled={!canConnectContainer || connectLoading}
                                    >
                                      {connectLoading && connectTarget?.type === 'volume-gui' && connectTarget.key === getMountConnectKey(mount) ? 'Opening...' : 'Connect Volume GUI'}
                                    </button>
                                    <button
                                      type="button"
                                      className="home-secondary-button"
                                      onClick={() => onConnectVolume(mount)}
                                      disabled={!canConnectContainer || connectLoading}
                                    >
                                      {connectLoading && connectTarget?.type === 'volume' && connectTarget.key === getMountConnectKey(mount) ? 'Opening...' : 'Connect Volume Terminal'}
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Available Networks to Attach */}
                      {networks && networks.length > 0 && (
                        <div className="container-section">
                          <h4>Add a network</h4>
                          <div className="available-networks">
                            {networks
                              .filter((net) => {
                                const netName = getNetworkName(net);
                                return !selectedContainerDetail.NetworkSettings?.Networks?.[netName];
                              })
                              .map((network) => (
                                <div key={getNetworkId(network)} className="available-network-item">
                                  <span>{getNetworkName(network)}</span>
                                  <button
                                    type="button"
                                    className="home-primary-button"
                                    onClick={() => onAttachNetwork(getNetworkName(network))}
                                    disabled={!canCreateNetwork || containerActionLoading}
                                  >
                                    Add
                                  </button>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="resource-empty-state">{containerTab === 'stopped' ? 'No stopped containers found.' : 'No running containers found.'}</p>
          )}
        </div>
      )}

      {deleteRecycledContainerTarget && (
        <div className="output-modal-backdrop" role="presentation">
          <div className="resource-delete-modal" role="dialog" aria-modal="true" aria-labelledby="recycled-container-delete-title">
            <h3 id="recycled-container-delete-title">Delete {deleteRecycledContainerTarget.container_name}?</h3>
            <p>
              This permanently removes the saved container snapshot and recycle-bin record for <strong>{deleteRecycledContainerTarget.container_name}</strong>.
              Its preserved filesystem data cannot be restored after deletion.
            </p>
            {deleteRecycledContainerMessage && <p className="container-message">{deleteRecycledContainerMessage}</p>}
            <div className="resource-modal-actions">
              <button
                type="button"
                className="home-danger-button"
                onClick={onConfirmDeleteRecycledContainer}
                disabled={deleteRecycledContainerLoading}
              >
                {deleteRecycledContainerLoading ? 'Deleting...' : 'Confirm'}
              </button>
              <button
                type="button"
                className="home-secondary-button"
                onClick={onCancelDeleteRecycledContainer}
                disabled={deleteRecycledContainerLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreContainerTarget && (
        <div className="output-modal-backdrop" role="presentation">
          <div className="resource-delete-modal" role="dialog" aria-modal="true" aria-labelledby="container-restore-title">
            <h3 id="container-restore-title">Restoring {restoreContainerTarget.container_name}</h3>
            <p>
              This container was deleted from {restoreContainerTarget.source_label || restoreContainerTarget.agent_name || 'Application server'}.
              Please select the same agent server before confirming restore.
            </p>
            <label>
              <span>Select restore agent</span>
              <select
                value={restoreContainerServerId || LOCAL_SERVER_ID}
                onChange={(event) => onRestoreContainerServerIdChange(event.target.value === LOCAL_SERVER_ID ? '' : event.target.value)}
                disabled={restoreContainerLoading}
              >
                <option value={LOCAL_SERVER_ID}>This application server (default)</option>
                {serverOptions
                  .filter((agent) => agent.id !== LOCAL_SERVER_ID)
                  .map((agent) => (
                    <option value={agent.id} key={agent.id}>
                      {agent.name} ({agent.server_ip}:{agent.port || 19541})
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Restored Docker image</span>
              <input
                type="text"
                value={restoreContainerImage}
                onChange={(event) => onRestoreContainerImageChange(event.target.value)}
                placeholder="nginx:latest"
                disabled={restoreContainerLoading}
              />
              <small className="field-help">The preserved snapshot will be renamed to this image and its recycle tag will be removed.</small>
            </label>
            {restoreContainerMessage && <p className="container-message">{restoreContainerMessage}</p>}
            <div className="resource-modal-actions">
              <button
                type="button"
                className="home-primary-button"
                onClick={onConfirmRestoreContainer}
                disabled={
                  restoreContainerLoading ||
                  !restoreContainerImage.trim() ||
                  String(restoreContainerServerId || LOCAL_SERVER_ID) !== String(restoreContainerTarget.agent_id || LOCAL_SERVER_ID)
                }
              >
                {restoreContainerLoading ? 'Restoring...' : 'Confirm'}
              </button>
              <button
                type="button"
                className="home-secondary-button"
                onClick={onCancelRestoreContainer}
                disabled={restoreContainerLoading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {connectMessage && (
        <p className="connect-message">{connectMessage}</p>
      )}

          {containerOutputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-output-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
          onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="container-output-title">Container output</h3>
              {containerLoading && <span className="live-output-badge">Live</span>}
              <button
                type="button"
                onClick={onCloseContainerOutput}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close output"
              >
                Close
              </button>
            </div>
            <pre>{containerCreateOutput || 'No output yet.'}</pre>
          </div>
        </div>
      )}

      {containerInspectOutputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal container-inspect-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-inspect-output-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
            onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="container-inspect-output-title">{containerInspectTitle}</h3>
              <button
                type="button"
                onClick={onCloseContainerInspect}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close inspect output"
              >
                Close
              </button>
            </div>
            <pre>{containerInspectOutput || 'No inspect output.'}</pre>
          </div>
        </div>
      )}

      {containerLogOutputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-log-output-title"
            style={{ transform: 'translate(' + outputModalPosition.x + 'px, ' + outputModalPosition.y + 'px)' }}
          onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="container-log-output-title">{containerLogTitle || 'Container logs'}</h3>
              <span className="live-output-badge">Live</span>
              <button
                type="button"
                onClick={onCloseContainerLogOutput}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close logs"
              >
                Close
              </button>
            </div>
            <pre>{containerLogOutput || 'No output yet.'}</pre>
          </div>
        </div>
      )}

      {connectModalOpen && activeShellContainer && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal connect-modal terminal-modal container-terminal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
            style={{ left: connectModalPosition.x + "px", top: connectModalPosition.y + "px", transform: "none" }}
            onPointerDown={onConnectModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="connect-title">{terminalTitle}</h3>
              <button
                type="button"
                onClick={onCloseConnectModal}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close terminal"
              >
                Close
              </button>
            </div>
            <div className="terminal-banner">connected to {terminalContainerName}</div>
            <div
              className="terminal-output"
              ref={terminalOutputRef}
              onClick={() => shellInputRef.current?.focus()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <pre>{shellOutput}</pre>
              {shellSessionId && (
                <form className="terminal-input-form" onSubmit={onSendShellCommand}>
                  {!activeShellContainer?.usesNativePrompt && <span className="terminal-prompt">{terminalPrompt}</span>}
                  <input
                    ref={shellInputRef}
                    type="text"
                    className="terminal-input"
                    value={shellInput}
                    onChange={(event) => onShellInputChange(event.target.value)}
                    disabled={shellInputLoading}
                    autoComplete="off"
                    spellCheck="false"
                    aria-label={`Terminal command for ${terminalContainerName}`}
                    autoFocus
                  />
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {volumeConnectModalOpen && activeVolumeShell && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal connect-modal terminal-modal volume-terminal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="volume-connect-title"
            style={{ left: volumeConnectModalPosition.x + "px", top: volumeConnectModalPosition.y + "px", transform: "none" }}
            onPointerDown={onVolumeConnectModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="volume-connect-title">Connected to volume: {activeVolumeShell.name}</h3>
              <button
                type="button"
                onClick={onCloseVolumeConnectModal}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close volume terminal"
              >
                Close
              </button>
            </div>
            <div className="terminal-banner">connected to {activeVolumeShell.containerName || "container"} volume {activeVolumeShell.name}</div>
            <div
              className="terminal-output"
              ref={volumeTerminalOutputRef}
              onClick={() => volumeShellInputRef.current?.focus()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <pre>{volumeShellOutput}</pre>
              {volumeShellSessionId && (
                <form className="terminal-input-form" onSubmit={onSendVolumeShellCommand}>
                  {!activeVolumeShell?.usesNativePrompt && <span className="terminal-prompt">{activeVolumeShell?.prompt || "/ #"}</span>}
                  <input
                    ref={volumeShellInputRef}
                    type="text"
                    className="terminal-input"
                    value={volumeShellInput}
                    onChange={(event) => onVolumeShellInputChange(event.target.value)}
                    disabled={volumeShellInputLoading}
                    autoComplete="off"
                    spellCheck="false"
                    aria-label="Terminal command for volume"
                    autoFocus
                  />
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {volumeGuiModalOpen && activeVolumeGui && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal connect-modal volume-gui-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="volume-gui-title"
            style={{ left: volumeGuiModalPosition.x + "px", top: volumeGuiModalPosition.y + "px", transform: "none" }}
            onPointerDown={onVolumeGuiModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <div>
                <h3 id="volume-gui-title">Volume files: {activeVolumeGui.name}</h3>
                <p>{activeVolumeGui.containerName || 'container'} {volumeGuiDisplayPath}</p>
              </div>
              <button
                type="button"
                onClick={onCloseVolumeGuiModal}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close volume files"
              >
                Close
              </button>
            </div>
            <div className="volume-gui-body" onPointerDown={(event) => event.stopPropagation()}>
              <div className="volume-gui-toolbar">
                <button type="button" className="home-secondary-button" onClick={onVolumeGuiUp} disabled={volumeGuiLoading || !volumeGuiPath}>Back</button>
                <button type="button" className="home-secondary-button" onClick={onVolumeGuiRefresh} disabled={volumeGuiLoading}>Refresh</button>
                <button type="button" className="home-secondary-button" onClick={onVolumeGuiNewFolder} disabled={volumeGuiLoading}>New folder</button>
                <button type="button" className="home-primary-button" onClick={onVolumeGuiUploadClick} disabled={volumeGuiLoading}>Upload</button>
                <input
                  ref={volumeGuiFileInputRef}
                  type="file"
                  className="volume-gui-file-input"
                  onChange={onVolumeGuiFileSelected}
                />
              </div>
              <div className="volume-gui-path">{volumeGuiDisplayPath}</div>
              {volumeGuiMessage && <p className="container-message error">{volumeGuiMessage}</p>}
              <div className="volume-gui-list" aria-busy={volumeGuiLoading}>
                {volumeGuiLoading ? (
                  <p className="resource-empty-state">Loading files...</p>
                ) : volumeGuiEntries.length > 0 ? (
                  volumeGuiEntries.map((entry) => (
                    <div className="volume-file-row" key={`${entry.type}-${entry.name}`}>
                      <button
                        type="button"
                        className="volume-file-main"
                        onClick={() => onVolumeGuiOpenEntry(entry)}
                      >
                        <span className="volume-file-icon" aria-hidden="true">{entry.type === 'directory' ? 'DIR' : 'FILE'}</span>
                        <span className="volume-file-name">{entry.name}</span>
                        <span className="volume-file-meta">{entry.type === 'directory' ? 'Folder' : formatVolumeFileSize(entry.size)}</span>
                      </button>
                      <div className="volume-file-actions">
                        {entry.type !== 'directory' && (
                          <button type="button" className="home-secondary-button" onClick={() => onVolumeGuiDownload(entry)}>Download</button>
                        )}
                        <button type="button" className="home-secondary-button" onClick={() => onVolumeGuiRename(entry)}>Rename</button>
                        <button type="button" className="home-danger-button" onClick={() => onVolumeGuiDelete(entry)}>Delete</button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="resource-empty-state">No files in this path.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}


      {(volumeFilePreviewLoading || volumeFilePreview || volumeFilePreviewMessage) && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal connect-modal volume-file-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="volume-file-preview-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
            onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading">
              <div>
                <h3 id="volume-file-preview-title">{volumeFilePreview?.filename || 'Opening file'}</h3>
                {volumeFilePreview?.path && <p>{volumeFilePreview.path}</p>}
              </div>
              <button
                type="button"
                onClick={onCloseVolumeFilePreview}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close file preview"
              >
                Close
              </button>
            </div>
            <div className="volume-file-preview-body" data-no-modal-drag>
              {volumeFilePreviewLoading ? (
                <p className="resource-empty-state">Opening file...</p>
              ) : volumeFilePreviewMessage ? (
                <p className="container-message error">{volumeFilePreviewMessage}</p>
              ) : volumeFilePreview?.kind === 'text' ? (
                <pre className="volume-file-preview-text">{volumeFilePreview.text}</pre>
              ) : volumeFilePreview?.kind === 'image' ? (
                <img className="volume-file-preview-image" src={volumeFilePreview.dataUrl} alt={volumeFilePreview.filename} />
              ) : volumeFilePreview?.kind === 'pdf' ? (
                <iframe className="volume-file-preview-frame" src={volumeFilePreview.dataUrl} title={volumeFilePreview.filename} />
              ) : volumeFilePreview?.kind === 'video' ? (
                <video className="volume-file-preview-media" src={volumeFilePreview.dataUrl} controls />
              ) : volumeFilePreview?.kind === 'audio' ? (
                <audio className="volume-file-preview-audio" src={volumeFilePreview.dataUrl} controls />
              ) : (
                <div className="volume-file-preview-empty">
                  <strong>{volumeFilePreview?.filename || 'File'}</strong>
                  <span>{volumeFilePreview?.mime || 'application/octet-stream'} · {formatVolumeFileSize(volumeFilePreview?.size || 0)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </section>
  );
}

function ensureBridgeNetwork(networks) {
  const hasBridge = networks.some((network) => getNetworkName(network) === 'bridge');
  return hasBridge ? networks : [{ Name: 'bridge', ID: 'bridge', Driver: 'bridge' }, ...networks];
}

function ensureLocalServerOption(agents) {
  const hasLocal = agents.some((agent) => agent.id === LOCAL_SERVER_ID);
  if (hasLocal) {
    return agents;
  }

  return [
    {
      id: LOCAL_SERVER_ID,
      name: 'Application server',
      server_ip: 'local',
      connected: true,
      containers_count: 0,
      images_count: 0,
      networks_count: 0,
      volumes_count: 0,
    },
    ...agents,
  ];
}

function encodeAgentPassword(password) {
  const bytes = new TextEncoder().encode(password);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function isSameBrowserHost(serverIp) {
  const target = String(serverIp || '').trim().toLowerCase();
  if (!target) {
    return false;
  }

  const browserHost = window.location.hostname.toLowerCase();
  return target === browserHost || ['localhost', '127.0.0.1', '::1'].includes(target);
}

function getContainerId(container) {
  return container?.ID || container?.Id || container?.id || '';
}

function getContainerName(container) {
  return container?.Names?.[0]?.replace(/^[/]/, '') || container?.Names || container?.Name || container?.name || 'Unknown';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asDisplayText(value, fallback = 'Unavailable') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return value.name || value.Name || value.id || value.ID || value.url || fallback;
  }
  return fallback;
}

function isContainerRunning(container) {
  const state = String(container?.State || container?.state || '').toLowerCase();
  const statusText = String(container?.Status || container?.status || '').toLowerCase();
  return state === 'running' || statusText.startsWith('up');
}

function getDeploymentContainerId(container) {
  return container?.id || container?.ID || container?.Id || '';
}

function formatDeploymentPort(port) {
  if (!port) return '';
  if (typeof port === 'string') return port;
  const privatePort = asDisplayText(port.container_port || port.private_port, '');
  const protocol = asDisplayText(port.protocol, 'tcp');
  const hostPort = asDisplayText(port.host_port || port.public_port, '');
  if (!privatePort && !hostPort) return '';
  return hostPort ? `${hostPort}:${privatePort || 'container'}/${protocol}` : `${privatePort}/${protocol}`;
}

function getDeploymentContainerAccessUrls(container) {
  return asArray(container?.access_urls)
    .map((item) => (typeof item === 'string' ? { url: item } : item))
    .filter((item) => item && item.url)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index);
}

function getDeploymentContainerPortLabels(container) {
  const labels = asArray(container?.ports).map(formatDeploymentPort).filter(Boolean);
  return labels.filter((label, index) => labels.indexOf(label) === index);
}

function getDeploymentMountLabel(mount) {
  if (typeof mount === 'string') return mount;
  const name = asDisplayText(mount?.name || mount?.source, 'volume');
  const destination = asDisplayText(mount?.destination, 'container');
  return `${name} -> ${destination}`;
}

function getDeploymentNetworkLabel(network) {
  if (typeof network === 'string') return network;
  const name = asDisplayText(network?.name, 'network');
  return network?.ip_address ? `${name} (${network.ip_address})` : name;
}

function getContainerImageReference(registryId, imageName) {
  const normalizedImage = imageName.trim();
  if (registryId === 'dockerfile') {
    return normalizedImage;
  }

  const firstSegment = normalizedImage.split('/')[0] || '';
  const hasRegistry = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';

  if (!normalizedImage || hasRegistry) {
    return normalizedImage;
  }

  const registry = CONTAINER_REGISTRIES.find((item) => item.id === registryId) || CONTAINER_REGISTRIES[0];
  if (registry.id === 'dockerhub' && !normalizedImage.includes('/')) {
    return `${registry.endpoint}/library/${normalizedImage}`;
  }

  return `${registry.endpoint}/${normalizedImage}`;
}

function VolumePanel({
  volumeName,
  volumeDriver,
  volumeLoading,
  volumeMessage,
  volumeTab,
  volumes,
  volumesLoading,
  volumesError,
  attachmentContainers,
  selectedVolumes,
  pendingDeleteVolumes,
  volumeDeleteLoading,
  volumeDeleteMessage,
  onVolumeNameChange,
  onVolumeDriverChange,
  onCreateVolume,
  onVolumeTabChange,
  onRefreshVolumes,
  onClearVolumeDeleteMessage,
  onSelectedVolumeChange,
  onConfirmDeleteVolume,
  onAcceptDeleteVolume,
  onRejectDeleteVolume,
  canOperate = () => true,
}) {
  const canCreateVolume = canOperate('create_volume');
  const canDeleteVolume = canOperate('delete_volume');

  return (
    <section className="home-panel volume-panel">
      <PanelIntro
        title="Volumes"
        description="Create persistent storage or safely remove volumes that are no longer attached."
      />
      <div className="volume-tabs" role="tablist" aria-label="Volume actions">
        <button
          type="button"
          role="tab"
          aria-selected={volumeTab === 'create'}
          className={volumeTab === 'create' ? 'active' : ''}
          onClick={() => onVolumeTabChange('create')}
        >
          New volume
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={volumeTab === 'delete'}
          className={volumeTab === 'delete' ? 'active' : ''}
          onClick={() => onVolumeTabChange('delete')}
        >
          Existing volumes
        </button>
      </div>

      {volumeTab === 'create' ? (
        <form className="volume-form" onSubmit={onCreateVolume}>
          <label>
            <span>Volume name</span>
            <input
              type="text"
              value={volumeName}
              onChange={(event) => onVolumeNameChange(event.target.value)}
              placeholder="example: app-data"
              disabled={volumeLoading}
            />
          </label>

          <label>
            <span>Driver</span>
            <input
              type="text"
              value={volumeDriver}
              onChange={(event) => onVolumeDriverChange(event.target.value)}
              disabled={volumeLoading}
            />
          </label>

          {volumeMessage && <p className="volume-message">{volumeMessage}</p>}

          <div className="volume-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={!canCreateVolume || volumeLoading || !volumeName.trim() || !volumeDriver.trim()}
            >
              {volumeLoading ? 'Creating volume...' : 'Create volume'}
            </button>
          </div>
        </form>
      ) : (
        <div className="volume-delete-panel">
          <div className="volume-delete-toolbar">
            <p>{selectedVolumes.length ? `Selected: ${selectedVolumes.length} volume(s)` : 'Select one or more volumes to delete.'}</p>
            <button
              type="button"
              className="home-secondary-button"
              onClick={() => {
                onClearVolumeDeleteMessage();
                onRefreshVolumes();
              }}
              disabled={volumesLoading}
            >
              Refresh
            </button>
          </div>

          {volumeDeleteMessage && <p className="volume-message">{volumeDeleteMessage}</p>}
          {volumesError && <p className="volume-message error">{volumesError}</p>}
          {volumesLoading ? (
            <p className="volume-empty-state">Loading volumes...</p>
          ) : volumes.length ? (
            <div className="volume-table-wrap">
              <table className="volume-table">
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Volume name</th>
                    <th>Volume ID</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {volumes.map((volume) => {
                    const name = getVolumeName(volume);
                    const id = getVolumeId(volume);
                    const selected = selectedVolumes.some((selectedVolume) => getVolumeName(selectedVolume) === name);

                    return (
                      <tr key={name || id} className={selected ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            name="selected-volume"
                            checked={selected}
                            onChange={() => onSelectedVolumeChange(volume)}
                            aria-label={`Select ${name}`}
                          />
                        </td>
                        <td><ResourceAttachmentIndicator attached={isVolumeAttached(name, attachmentContainers)} label={name} /></td>
                        <td>{id}</td>
                        <td>{volume.Driver || volume.driver || 'local'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="volume-empty-state">No Docker volumes found.</p>
          )}

          {selectedVolumes.length > 0 && (
            <div className="volume-actions">
              <button
                type="button"
                className="home-danger-button"
                onClick={onConfirmDeleteVolume}
                disabled={!canDeleteVolume}
              >
                Delete selected volumes
              </button>
            </div>
          )}
        </div>
      )}

      {pendingDeleteVolumes.length > 0 && (
        <VolumeDeleteModal
          volumes={pendingDeleteVolumes}
          loading={volumeDeleteLoading}
          onAccept={onAcceptDeleteVolume}
          onReject={onRejectDeleteVolume}
        />
      )}
    </section>
  );
}

function VolumeDeleteModal({ volumes, loading, onAccept, onReject }) {
  return (
    <div className="output-modal-backdrop" role="presentation">
      <div className="volume-delete-modal" role="dialog" aria-modal="true" aria-labelledby="volume-delete-title">
        <h3 id="volume-delete-title">Delete selected volumes?</h3>
        <p>This will permanently remove {volumes.length} Docker volume(s). Containers using a volume will block deletion.</p>
        <div className="resource-delete-list">
          {volumes.map((volume) => (
            <dl key={getVolumeName(volume)}>
              <div>
                <dt>Name</dt>
                <dd>{getVolumeName(volume)}</dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd>{getVolumeId(volume)}</dd>
              </div>
            </dl>
          ))}
        </div>
        <div className="volume-modal-actions">
          <button type="button" className="home-danger-button" onClick={onAccept} disabled={loading}>
            {loading ? 'Deleting...' : 'Delete'}
          </button>
          <button type="button" className="home-secondary-button" onClick={onReject} disabled={loading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function getMountConnectKey(mount) {
  return [mount?.Type || '', mount?.Name || '', mount?.Source || '', mount?.Destination || ''].join('|');
}

function getVolumeName(volume) {
  return volume?.Name || volume?.name || volume?.VolumeName || 'Unavailable';
}

function getVolumeId(volume) {
  return volume?.ID || volume?.Id || volume?.id || getVolumeName(volume);
}

function formatVolumeDeleteFailureMessage(deletedCount, failed) {
  const failureMessages = failed.map(({ result, volume }) => {
    const name = getVolumeName(volume);
    const backendMessage = result.reason?.response?.data?.output || result.reason?.response?.data?.error || '';
    const isInUse = /volume is in use|is in use|used by container|remove.*container/i.test(backendMessage);

    if (isInUse) {
      return `Can't delete ${name}; this volume is currently used by a container.`;
    }

    return backendMessage ? `Can't delete ${name}: ${backendMessage}` : `Can't delete ${name}.`;
  });

  if (deletedCount > 0) {
    return `Deleted ${deletedCount} volume(s). ${failureMessages.join(' ')}`;
  }

  return failureMessages.join(' ');
}

function toggleSelectedItem(items, item, getKey) {
  const itemKey = getKey(item);
  if (items.some((selectedItem) => getKey(selectedItem) === itemKey)) {
    return items.filter((selectedItem) => getKey(selectedItem) !== itemKey);
  }

  return [...items, item];
}

function NetworkPanel({
  networkName,
  networkDriver,
  networkLoading,
  networkMessage,
  networkTab,
  networks,
  networksLoading,
  networksError,
  attachmentContainers,
  selectedNetworks,
  pendingDeleteNetworks,
  networkDeleteLoading,
  networkDeleteMessage,
  onNetworkNameChange,
  onNetworkDriverChange,
  onCreateNetwork,
  onNetworkTabChange,
  onRefreshNetworks,
  onClearNetworkDeleteMessage,
  onSelectedNetworkChange,
  onConfirmDeleteNetwork,
  onAcceptDeleteNetwork,
  onRejectDeleteNetwork,
  canOperate = () => true,
}) {
  const canCreateNetwork = canOperate('create_network');
  const canDeleteNetwork = canOperate('delete_network');

  return (
    <section className="home-panel network-panel">
      <PanelIntro
        title="Networks"
        description="Create Docker networks and remove only the networks that are safe to delete."
      />
      <div className="resource-tabs" role="tablist" aria-label="Network actions">
        <button
          type="button"
          role="tab"
          aria-selected={networkTab === 'create'}
          className={networkTab === 'create' ? 'active' : ''}
          onClick={() => onNetworkTabChange('create')}
        >
          New network
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={networkTab === 'delete'}
          className={networkTab === 'delete' ? 'active' : ''}
          onClick={() => onNetworkTabChange('delete')}
        >
          Existing networks
        </button>
      </div>

      {networkTab === 'create' ? (
        <form className="network-form" onSubmit={onCreateNetwork}>
          <label>
            <span>Network name</span>
            <input
              type="text"
              value={networkName}
              onChange={(event) => onNetworkNameChange(event.target.value)}
              placeholder="example: app-network"
              disabled={networkLoading}
            />
          </label>

          <label>
            <span>Driver</span>
            <select
              value={networkDriver}
              onChange={(event) => onNetworkDriverChange(event.target.value)}
              disabled={networkLoading}
            >
              <option value="bridge">Bridge - private network</option>
              <option value="host">Host - share server networking</option>
              <option value="none">None - no networking</option>
            </select>
          </label>

          {networkMessage && <p className="network-message">{networkMessage}</p>}

          <div className="network-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={!canCreateNetwork || networkLoading || !networkName.trim()}
            >
              {networkLoading ? 'Creating network...' : 'Create network'}
            </button>
          </div>
        </form>
      ) : (
        <div className="resource-delete-panel">
          <div className="resource-delete-toolbar">
            <p>{selectedNetworks.length ? `Selected: ${selectedNetworks.length} network(s)` : 'Select one or more networks to delete.'}</p>
            <button
              type="button"
              className="home-secondary-button"
              onClick={() => {
                onClearNetworkDeleteMessage();
                onRefreshNetworks();
              }}
              disabled={networksLoading}
            >
              Refresh
            </button>
          </div>

          {networkDeleteMessage && <p className="network-message">{networkDeleteMessage}</p>}
          {networksError && <p className="network-message error">{networksError}</p>}
          {networksLoading ? (
            <p className="resource-empty-state">Loading networks...</p>
          ) : networks.length ? (
            <div className="resource-table-wrap">
              <table className="resource-table">
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Network name</th>
                    <th>Network ID</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {networks.map((network) => {
                    const name = getNetworkName(network);
                    const id = getNetworkId(network);
                    const selected = selectedNetworks.some((selectedNetwork) => getNetworkId(selectedNetwork) === id);

                    return (
                      <tr key={id || name} className={selected ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            name="selected-network"
                            checked={selected}
                            onChange={() => onSelectedNetworkChange(network)}
                            aria-label={`Select ${name}`}
                          />
                        </td>
                        <td><ResourceAttachmentIndicator attached={isNetworkAttached(name, attachmentContainers)} label={name} /></td>
                        <td>{id}</td>
                        <td>{network.Driver || network.driver || 'bridge'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="resource-empty-state">No Docker networks found.</p>
          )}

          {selectedNetworks.length > 0 && (
            <div className="network-actions">
              <button
                type="button"
                className="home-danger-button"
                onClick={onConfirmDeleteNetwork}
                disabled={!canDeleteNetwork}
              >
                Delete selected networks
              </button>
            </div>
          )}
        </div>
      )}

      {pendingDeleteNetworks.length > 0 && (
        <NetworkDeleteModal
          networks={pendingDeleteNetworks}
          loading={networkDeleteLoading}
          onAccept={onAcceptDeleteNetwork}
          onReject={onRejectDeleteNetwork}
        />
      )}
    </section>
  );
}

function NetworkDeleteModal({ networks, loading, onAccept, onReject }) {
  return (
    <div className="output-modal-backdrop" role="presentation">
      <div className="resource-delete-modal" role="dialog" aria-modal="true" aria-labelledby="network-delete-title">
        <h3 id="network-delete-title">Delete selected networks?</h3>
        <p>This will remove {networks.length} Docker network(s). Networks with active containers will stay protected.</p>
        <div className="resource-delete-list">
          {networks.map((network) => (
            <dl key={getNetworkId(network)}>
              <div>
                <dt>Name</dt>
                <dd>{getNetworkName(network)}</dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd>{getNetworkId(network)}</dd>
              </div>
            </dl>
          ))}
        </div>
        <div className="resource-modal-actions">
          <button type="button" className="home-danger-button" onClick={onAccept} disabled={loading}>
            {loading ? 'Deleting...' : 'Delete'}
          </button>
          <button type="button" className="home-secondary-button" onClick={onReject} disabled={loading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function getAgentStatus(agent) {
  if (agent?.connected) {
    return { label: 'Connected', className: 'agent-status connected' };
  }
  if (agent?.last_seen) {
    return { label: 'Down', className: 'agent-status down' };
  }
  return { label: 'Waiting', className: 'agent-status' };
}


function getNetworkName(network) {
  return network?.Name || network?.name || 'Unavailable';
}

function getNetworkId(network) {
  return network?.ID || network?.Id || network?.id || getNetworkName(network);
}

function formatNetworkDeleteFailureMessage(deletedCount, failed) {
  const failureMessages = failed.map(({ result, network }) => {
    const name = getNetworkName(network);
    const backendMessage = result.reason?.response?.data?.output || result.reason?.response?.data?.error || '';
    const isInUse = /active endpoints|network.*in use|has active|container/i.test(backendMessage);

    if (isInUse) {
      return `Can't delete ${name}; this network is currently used by a container.`;
    }

    return backendMessage ? `Can't delete ${name}: ${backendMessage}` : `Can't delete ${name}.`;
  });

  if (deletedCount > 0) {
    return `Deleted ${deletedCount} network(s). ${failureMessages.join(' ')}`;
  }

  return failureMessages.join(' ');
}

function DeploymentPanel({
  deploymentName,
  composeFilePath,
  deploymentServerId,
  deploymentTab,
  deploymentLoading,
  deploymentMessage,
  deploymentOutput,
  deploymentJobId,
  deploymentOutputOpen,
  outputModalPosition,
  composeBrowserOpen,
  composeBrowserData,
  composeBrowserLoading,
  composeBrowserError,
  deployments,
  deploymentsLoading,
  deploymentsError,
  selectedDeploymentId,
  deploymentDetail,
  deploymentDetailLoading,
  deploymentActionMessage,
  deploymentActionLoading,
  agents,
  agentsLoading,
  networks,
  volumes,
  selectedDeploymentNetwork,
  selectedDeploymentVolume,
  containerLogOutput,
  containerLogTitle,
  containerLogOutputOpen,
  connectModalOpen,
  connectModalPosition,
  connectLoading,
  connectTarget,
  connectMessage,
  activeShellContainer,
  shellSessionId,
  shellOutput,
  shellInput,
  shellInputLoading,
  shellInputRef,
  onDeploymentNameChange,
  onComposeFilePathChange,
  onDeploymentServerIdChange,
  onDeploymentTabChange,
  onDeployApplication,
  onStopDeployment,
  onOpenDeploymentOutput,
  onCloseDeploymentOutput,
  onOutputModalDragStart,
  onOpenComposeBrowser,
  onCloseComposeBrowser,
  onBrowseComposePath,
  onSelectComposeFile,
  onRefreshDeployments,
  onSelectDeployment,
  onRefreshDeploymentDetail,
  onDeleteDeployment,
  onRestartDeployment,
  onDeploymentContainerAction,
  onDeploymentConnect,
  onDeploymentLogs,
  onDeploymentNetworkChange,
  onDeploymentVolumeChange,
  onSelectedDeploymentNetworkChange,
  onSelectedDeploymentVolumeChange,
  onCloseContainerLogOutput,
  onShellInputChange,
  onSendShellCommand,
  onCloseConnectModal,
  onConnectModalDragStart,
  canOperate = () => true,
}) {
  const terminalOutputRef = useRef(null);
  const selectedDeployment = deployments.find((deployment) => String(deployment.id) === String(selectedDeploymentId))
    || deploymentDetail?.deployment
    || null;
  const containers = asArray(deploymentDetail?.containers);
  const attachedImages = asArray(deploymentDetail?.images).map((item) => asDisplayText(item, '')).filter(Boolean);
  const attachedNetworks = asArray(deploymentDetail?.networks).map((item) => asDisplayText(item, '')).filter(Boolean);
  const attachedVolumes = asArray(deploymentDetail?.volumes).map((item) => asDisplayText(item, '')).filter(Boolean);
  const applicationUrls = asArray(deploymentDetail?.application_urls)
    .map((item) => (typeof item === 'string' ? { url: item } : item))
    .filter((item) => item && item.url)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index);
  const canCreateDeployment = canOperate('create_deployment');
  const canDeleteDeployment = canOperate('delete_deployment');
  const canConnectContainer = canOperate('connect_container');
  const canCreateNetwork = canOperate('create_network');
  const canDeleteNetwork = canOperate('delete_network');
  const getContainerNetworkNames = (container) =>
    asArray(container?.networks).map((network) => network?.name || network?.Name || network).filter(Boolean);
  const getContainerVolumeNames = (container) =>
    asArray(container?.mounts)
      .filter((mount) => (mount?.type || mount?.Type) === 'volume')
      .map((mount) => mount?.name || mount?.Name)
      .filter(Boolean);
  const getAvailableNetworkOptions = (container) => {
    const attached = new Set(getContainerNetworkNames(container));
    return asArray(networks).filter((network) => !attached.has(getNetworkName(network)));
  };
  const getAvailableVolumeOptions = (container) => {
    const attached = new Set(getContainerVolumeNames(container));
    return asArray(volumes).filter((volume) => !attached.has(getVolumeName(volume)));
  };

  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [shellOutput, connectModalOpen]);

  return (
    <section className="home-panel deployment-panel">
      <PanelIntro
        title="Deployments"
        description="Launch Compose applications, review their containers, and attach networks or volumes when needed."
      />
      <div className="resource-tabs" role="tablist" aria-label="Deployment actions">
        <button
          type="button"
          role="tab"
          aria-selected={deploymentTab === 'deploy'}
          className={deploymentTab === 'deploy' ? 'active' : ''}
          onClick={() => onDeploymentTabChange('deploy')}
          disabled={!canCreateDeployment}
        >
          Deploy
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={deploymentTab === 'existing'}
          className={deploymentTab === 'existing' ? 'active' : ''}
          onClick={() => {
            onDeploymentTabChange('existing');
            onRefreshDeployments();
          }}
        >
          Existing deployments
        </button>
      </div>

      {deploymentTab === 'deploy' && canCreateDeployment ? (
        <form className="build-image-form" onSubmit={onDeployApplication}>
          <label>
            <span>Deployment name</span>
            <input
              type="text"
              value={deploymentName}
              onChange={(event) => onDeploymentNameChange(event.target.value)}
              placeholder="example: production-stack"
              disabled={deploymentLoading}
            />
          </label>

          <label>
            <span>Docker Compose file</span>
            <div className="path-picker-row">
              <input
                type="text"
                value={composeFilePath}
                onChange={(event) => onComposeFilePathChange(event.target.value)}
                placeholder="/home/vitel/vitel-container/docker-compose.yaml"
                disabled={deploymentLoading}
              />
              <button
                type="button"
                className="home-secondary-button"
                onClick={onOpenComposeBrowser}
                disabled={deploymentLoading}
              >
                Browse
              </button>
            </div>
          </label>

          <label className="agent-select-field">
            <span>Select Agent</span>
            <select
              value={deploymentServerId}
              onChange={(event) => onDeploymentServerIdChange(event.target.value)}
              disabled={deploymentLoading || agentsLoading}
            >
              <option value="">This application server (default)</option>
              {ensureLocalServerOption(agents)
                .filter((agent) => agent.id !== LOCAL_SERVER_ID)
                .map((agent) => (
                  <option value={agent.id} key={agent.id} disabled={!agent.connected}>
                    {agent.name} ({agent.server_ip}:{agent.port || 19541}) {agent.connected ? '' : '- Down'}
                  </option>
                ))}
            </select>
          </label>

          {deploymentMessage && <p className="build-message">{deploymentMessage}</p>}

          <div className="build-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={!canCreateDeployment || deploymentLoading || !deploymentName.trim() || !composeFilePath.trim()}
            >
              {deploymentLoading ? 'Deploying application...' : 'Deploy application'}
            </button>
            <button
              type="button"
              className="home-danger-button"
              onClick={onStopDeployment}
              disabled={!deploymentLoading || !deploymentJobId}
            >
              Stop deployment
            </button>
            <button type="button" className="home-secondary-button" onClick={onOpenDeploymentOutput}>
              View deployment output
            </button>
          </div>
        </form>
      ) : (
        <div className="deployment-existing-grid">
          <div className="deployment-list-panel">
            <div className="resource-delete-toolbar">
              <p>{deployments.length ? `${deployments.length} deployment(s) available.` : 'No deployments found.'}</p>
              <button type="button" className="home-secondary-button" onClick={onRefreshDeployments} disabled={deploymentsLoading}>
                Refresh
              </button>
            </div>

            {deploymentsError && <p className="build-message error">{deploymentsError}</p>}
            {deploymentsLoading ? (
              <p className="resource-empty-state">Loading deployments...</p>
            ) : deployments.length ? (
              <div className="deployment-list">
                {deployments.map((deployment) => (
                  <button
                    type="button"
                    key={deployment.id}
                    className={String(selectedDeploymentId) === String(deployment.id) ? 'deployment-list-item active' : 'deployment-list-item'}
                    onClick={(event) => onSelectDeployment(String(deployment.id), event)}
                  >
                    <strong>{asDisplayText(deployment.name, 'Deployment')}</strong>
                    <span>{asDisplayText(deployment.status, 'unknown')}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="resource-empty-state">No deployments found.</p>
            )}
          </div>

          <div className="deployment-detail-panel">
            {selectedDeployment ? (
              <>
                <div className="resource-delete-toolbar">
                  <p>{asDisplayText(selectedDeployment.name, 'Deployment')}</p>
                  <button
                    type="button"
                    className="home-secondary-button"
                    onClick={onRefreshDeploymentDetail}
                    disabled={deploymentDetailLoading}
                  >
                    Refresh details
                  </button>
                  <button
                    type="button"
                    className="home-primary-button"
                    onClick={onRestartDeployment}
                    disabled={deploymentActionLoading || deploymentDetailLoading || !containers.length}
                  >
                    Restart deployment
                  </button>
                  <button
                    type="button"
                    className="home-danger-button"
                    onClick={onDeleteDeployment}
                    disabled={!canDeleteDeployment || deploymentActionLoading}
                  >
                    Delete deployment
                  </button>
                </div>

                {deploymentActionMessage && <p className="container-message">{deploymentActionMessage}</p>}
                {deploymentDetailLoading ? (
                  <p className="resource-empty-state">Loading deployment details...</p>
                ) : deploymentDetail ? (
                  <>
                    <div className="resource-dashboard compact">
                      <article className="resource-stat-card">
                        <span>Images</span>
                        <strong>{attachedImages.length}</strong>
                      </article>
                      <article className="resource-stat-card">
                        <span>Containers</span>
                        <strong>{containers.length}</strong>
                      </article>
                      <article className="resource-stat-card">
                        <span>Volumes</span>
                        <strong>{attachedVolumes.length}</strong>
                      </article>
                      <article className="resource-stat-card">
                        <span>Networks</span>
                        <strong>{attachedNetworks.length}</strong>
                      </article>
                      <article className="resource-stat-card">
                        <span>URLs</span>
                        <strong>{applicationUrls.length}</strong>
                      </article>
                    </div>

                    <div className="deployment-access-list">
                      <h3>Application access URLs</h3>
                      {applicationUrls.length ? (
                        <div>
                          {applicationUrls.map((item) => (
                            <a href={item.url} target="_blank" rel="noreferrer" key={`${item.url}-${item.container_port}`}>
                              {item.url}
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="resource-empty-state">No published application ports found.</p>
                      )}
                    </div>

                    <div className="deployment-summary-lists">
                      <DeploymentPillList title="Images" items={attachedImages} />
                      <DeploymentPillList title="Volumes" items={attachedVolumes} />
                      <DeploymentPillList title="Networks" items={attachedNetworks} />
                    </div>

                    <div className="deployment-containers">
                      {containers.map((container) => (
                        <article className="deployment-container-card" key={container.id}>
                          <div className="agent-card-heading">
                            <h3>{asDisplayText(container.name, 'container')}</h3>
                            <span className={container.running ? 'agent-status connected' : 'agent-status'}>
                              {container.running ? 'Running' : 'Stopped'}
                            </span>
                          </div>
                          <dl>
                            <div>
                              <dt>Image name</dt>
                              <dd>{asDisplayText(container.image)}</dd>
                            </div>
                            <div>
                              <dt>Image ID</dt>
                              <dd>{container.image_id ? asDisplayText(container.image_id).replace(/^sha256:/, '').slice(0, 12) : 'Unavailable'}</dd>
                            </div>
                            <div>
                              <dt>Status</dt>
                              <dd>{asDisplayText(container.status)}</dd>
                            </div>
                            <div>
                              <dt>Ports</dt>
                              <dd>{getDeploymentContainerPortLabels(container).join(', ') || 'None'}</dd>
                            </div>
                            <div>
                              <dt>Application access URL</dt>
                              <dd className="deployment-url-list">
                                {getDeploymentContainerAccessUrls(container).length ? (
                                  getDeploymentContainerAccessUrls(container).map((item) => (
                                    <a href={item.url} target="_blank" rel="noreferrer" key={`${container.id}-${item.url}`}>
                                      {item.url}
                                    </a>
                                  ))
                                ) : 'None'}
                              </dd>
                            </div>
                            <div>
                              <dt>Volumes</dt>
                              <dd>{asArray(container.mounts).map(getDeploymentMountLabel).filter(Boolean).join(', ') || 'None'}</dd>
                            </div>
                            <div>
                              <dt>Networks</dt>
                              <dd>{asArray(container.networks).map(getDeploymentNetworkLabel).filter(Boolean).join(', ') || 'None'}</dd>
                            </div>
                          </dl>

                          <div className="deployment-container-actions">
                            <button
                              type="button"
                              className="home-primary-button"
                              onClick={() => onDeploymentContainerAction(container, 'restart')}
                              disabled={deploymentActionLoading}
                            >
                              Restart
                            </button>
                            <button
                              type="button"
                              className="home-danger-button"
                              onClick={() => onDeploymentContainerAction(container, 'stop')}
                              disabled={deploymentActionLoading || !container.running}
                            >
                              Stop
                            </button>
                            <button
                              type="button"
                              className="home-secondary-button"
                              onClick={() => onDeploymentConnect(container)}
                              disabled={!canConnectContainer || connectLoading || !container.running}
                            >
                              {connectLoading && connectTarget?.type === 'deployment-container' && connectTarget.key === getDeploymentContainerId(container) ? 'Opening terminal...' : 'Open terminal'}
                            </button>
                            <button type="button" className="home-secondary-button" onClick={() => onDeploymentLogs(container)}>
                              View logs
                            </button>
                          </div>

                          <div className="deployment-attach-grid">
                            <div className="deployment-attached-resources">
                              <span>Attached networks</span>
                              <div>
                                {getContainerNetworkNames(container).length ? (
                                  getContainerNetworkNames(container).map((networkName) => (
                                    <button
                                      type="button"
                                      className="resource-chip-button"
                                      key={networkName}
                                      onClick={() => onDeploymentNetworkChange(container, networkName, 'detach')}
                                      disabled={!canDeleteNetwork || deploymentActionLoading}
                                    >
                                      Remove {networkName}
                                    </button>
                                  ))
                                ) : (
                                  <small>None</small>
                                )}
                              </div>
                            </div>

                            <label>
                              <span>Add network</span>
                              <select
                                value={selectedDeploymentNetwork}
                                onChange={(event) => onSelectedDeploymentNetworkChange(event.target.value)}
                                disabled={deploymentActionLoading}
                              >
                                <option value="">Choose a network</option>
                                {getAvailableNetworkOptions(container).map((network) => {
                                  const name = getNetworkName(network);
                                  return <option value={name} key={name}>{name}</option>;
                                })}
                              </select>
                            </label>
                            <div className="deployment-attach-actions">
                              <button
                                type="button"
                                className="home-secondary-button"
                                onClick={() => onDeploymentNetworkChange(container, selectedDeploymentNetwork, 'attach')}
                                disabled={!canCreateNetwork || !selectedDeploymentNetwork || deploymentActionLoading}
                              >
                                Attach network
                              </button>
                              <button
                                type="button"
                                className="home-secondary-button"
                                onClick={() => onDeploymentNetworkChange(container, selectedDeploymentNetwork, 'detach')}
                                disabled={!canDeleteNetwork || !selectedDeploymentNetwork || deploymentActionLoading}
                              >
                                Remove selected network
                              </button>
                            </div>

                            <div className="deployment-attached-resources">
                              <span>Attached volumes</span>
                              <div>
                                {getContainerVolumeNames(container).length ? (
                                  getContainerVolumeNames(container).map((volumeName) => (
                                    <button
                                      type="button"
                                      className="resource-chip-button"
                                      key={volumeName}
                                      onClick={() => onDeploymentVolumeChange(container, volumeName, 'detach')}
                                      disabled={deploymentActionLoading}
                                    >
                                      Remove {volumeName}
                                    </button>
                                  ))
                                ) : (
                                  <small>None</small>
                                )}
                              </div>
                            </div>

                            <label>
                              <span>Add volume</span>
                              <select
                                value={selectedDeploymentVolume}
                                onChange={(event) => onSelectedDeploymentVolumeChange(event.target.value)}
                                disabled={deploymentActionLoading}
                              >
                                <option value="">Choose a volume</option>
                                {getAvailableVolumeOptions(container).map((volume) => {
                                  const name = getVolumeName(volume);
                                  return <option value={name} key={name}>{name}</option>;
                                })}
                              </select>
                            </label>
                            <div className="deployment-attach-actions">
                              <button
                                type="button"
                                className="home-secondary-button"
                                onClick={() => onDeploymentVolumeChange(container, selectedDeploymentVolume, 'attach')}
                                disabled={!selectedDeploymentVolume || deploymentActionLoading}
                              >
                                Attach volume
                              </button>
                              <button
                                type="button"
                                className="home-secondary-button"
                                onClick={() => onDeploymentVolumeChange(container, selectedDeploymentVolume, 'detach')}
                                disabled={!selectedDeploymentVolume || deploymentActionLoading}
                              >
                                Remove selected volume
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="resource-empty-state">Select a deployment to inspect it.</p>
                )}
              </>
            ) : (
              <p className="resource-empty-state">Select a deployment to inspect it.</p>
            )}
          </div>
        </div>
      )}

      {deploymentOutputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deployment-output-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
          onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="deployment-output-title">Deployment Output</h3>
              {deploymentLoading && <span className="live-output-badge">Live</span>}
              <button
                type="button"
                onClick={onCloseDeploymentOutput}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close output"
              >
                Close
              </button>
            </div>
            <pre>{deploymentOutput || 'No output yet.'}</pre>
          </div>
        </div>
      )}

      {containerLogOutputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-log-output-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
          onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="container-log-output-title">{containerLogTitle || 'Container Output'}</h3>
              <button
                type="button"
                onClick={onCloseContainerLogOutput}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close output"
              >
                Close
              </button>
            </div>
            <pre>{containerLogOutput || 'No output yet.'}</pre>
          </div>
        </div>
      )}

      {composeBrowserOpen && (
        <ComposeFileBrowserModal
          data={composeBrowserData}
          loading={composeBrowserLoading}
          error={composeBrowserError}
          onBrowsePath={onBrowseComposePath}
          onSelectComposeFile={onSelectComposeFile}
          onClose={onCloseComposeBrowser}
        />
      )}

      {connectModalOpen && activeShellContainer && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal connect-modal terminal-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deployment-terminal-title"
            style={{
              left: `${connectModalPosition.x}px`,
              top: `${connectModalPosition.y}px`,
              transform: 'none',
            }}
            onPointerDown={onConnectModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="deployment-terminal-title">Terminal: {activeShellContainer.name}</h3>
              <button
                type="button"
                onClick={onCloseConnectModal}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close terminal"
              >
                Close
              </button>
            </div>
            <div
              className="terminal-output"
              ref={terminalOutputRef}
              onClick={() => shellInputRef.current?.focus()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <pre>{shellOutput}</pre>
              {shellSessionId && (
                <form className="terminal-input-form" onSubmit={onSendShellCommand}>
                  {!activeShellContainer?.usesNativePrompt && <span className="terminal-prompt">{"root@" + activeShellContainer.name + ":/#"}</span>}
                  <input
                    ref={shellInputRef}
                    type="text"
                    className="terminal-input"
                    value={shellInput}
                    onChange={(event) => onShellInputChange(event.target.value)}
                    disabled={shellInputLoading}
                    autoComplete="off"
                    spellCheck="false"
                    aria-label={`Terminal command for ${activeShellContainer.name}`}
                    autoFocus
                  />
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DeploymentPillList({ title, items }) {
  return (
    <div className="deployment-pill-list">
      <h3>{title}</h3>
      <div>
        {items.length ? items.map((item) => <span key={item}>{item}</span>) : <span>None</span>}
      </div>
    </div>
  );
}

function ComposeFileBrowserModal({
  data,
  loading,
  error,
  onBrowsePath,
  onSelectComposeFile,
  onClose,
}) {
  const directories = data?.directories || [];
  const composeFiles = data?.compose_files || [];
  const dataError = data?.error;

  return (
    <div className="output-modal-backdrop" role="presentation">
      <div className="file-browser-modal" role="dialog" aria-modal="true" aria-labelledby="compose-browser-title">
        <div className="output-modal-heading">
          <div>
            <h3 id="compose-browser-title">Select Docker Compose file</h3>
            <p>{data?.current_path || 'Loading server folders...'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close file browser">
            Close
          </button>
        </div>

        <div className="file-browser-body">
          {error && <p className="file-browser-error">{error}</p>}
          {dataError && <p className="file-browser-error">{dataError}</p>}
          {loading && <p className="file-browser-status">Loading...</p>}

          {data?.parent_path && (
            <button
              type="button"
              className="file-browser-row parent"
              onClick={() => onBrowsePath(data.parent_path)}
            >
              Back one folder
            </button>
          )}

          {directories.map((directory) => (
            <button
              type="button"
              className="file-browser-row"
              key={directory.path}
              onClick={() => onBrowsePath(directory.path)}
            >
              {directory.name}/
            </button>
          ))}

          {composeFiles.map((composeFile) => (
            <button
              type="button"
              className="file-browser-row file"
              key={composeFile.path}
              onClick={() => onSelectComposeFile(composeFile.path)}
            >
              {composeFile.name}
            </button>
          ))}

          {!loading && !directories.length && !composeFiles.length && (
            <p className="file-browser-status">No Compose YAML files found in this folder.</p>
          )}
        </div>
      </div>
    </div>
  );
}


function RegistryPanel({
  agents,
  agentsLoading,
  images,
  imagesLoading,
  imagesError,
  selectedAgentId,
  selectedImageId,
  containerName,
  runArgs,
  registryUsername,
  registryPassword,
  deployLoading,
  deployMessage,
  deployOutput,
  onSelectedAgentChange,
  onSelectedImageChange,
  onContainerNameChange,
  onRunArgsChange,
  onRegistryUsernameChange,
  onRegistryPasswordChange,
  onDeploy,
  onRefreshImages,
  onRefreshAgents,
  canOperate = () => true,
}) {
  const connectedAgents = agents.filter((agent) => agent.id !== LOCAL_SERVER_ID && agent.connected);
  const selectedImage = images.find((image) => String(image.id) === String(selectedImageId));
  const canDeploy = canOperate('create_deployment');

  return (
    <section className="home-panel deployment-panel">
      <PanelIntro
        title="Registry Deploy"
        description="Queue a connected agent to pull a tagged image from the self-hosted registry and run it."
      />

      <form className="build-image-form" onSubmit={onDeploy}>
        <label className="agent-select-field">
          <span>Select Agent</span>
          <select
            value={selectedAgentId}
            onChange={(event) => onSelectedAgentChange(event.target.value)}
            disabled={deployLoading || agentsLoading}
          >
            <option value="">Select connected agent</option>
            {connectedAgents.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.name} ({agent.server_ip}:{agent.port || 19541})
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Registry image</span>
          <select
            value={selectedImageId}
            onChange={(event) => onSelectedImageChange(event.target.value)}
            disabled={deployLoading || imagesLoading}
          >
            <option value="">Select image tag</option>
            {images.map((image) => (
              <option value={image.id} key={image.id}>
                {image.reference || `${image.name}:${image.tag}`}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Container name</span>
          <input
            type="text"
            value={containerName}
            onChange={(event) => onContainerNameChange(event.target.value)}
            placeholder={selectedImage ? selectedImage.name.split('/').pop() : 'example: web-app'}
            disabled={deployLoading}
          />
        </label>

        <label>
          <span>Run arguments</span>
          <input
            type="text"
            value={runArgs}
            onChange={(event) => onRunArgsChange(event.target.value)}
            placeholder="example: -p 8080:80 --env NODE_ENV=production"
            disabled={deployLoading}
          />
        </label>

        <label>
          <span>Registry username</span>
          <input
            type="text"
            value={registryUsername}
            onChange={(event) => onRegistryUsernameChange(event.target.value)}
            placeholder="optional"
            disabled={deployLoading}
            autoComplete="off"
          />
        </label>

        <label>
          <span>Registry password</span>
          <input
            type="password"
            value={registryPassword}
            onChange={(event) => onRegistryPasswordChange(event.target.value)}
            placeholder="optional"
            disabled={deployLoading}
            autoComplete="new-password"
          />
        </label>

        {deployMessage && <p className="build-message">{deployMessage}</p>}
        {imagesError && <p className="build-message error">{imagesError}</p>}

        <div className="build-actions">
          <button
            type="submit"
            className="home-primary-button"
            disabled={!canDeploy || deployLoading || !selectedAgentId || !selectedImageId}
          >
            {deployLoading ? 'Queueing deployment...' : 'Deploy image'}
          </button>
          <button type="button" className="home-secondary-button" onClick={onRefreshImages} disabled={imagesLoading || deployLoading}>
            Refresh images
          </button>
          <button type="button" className="home-secondary-button" onClick={onRefreshAgents} disabled={agentsLoading || deployLoading}>
            Refresh agents
          </button>
        </div>
      </form>

      <div className="agent-command-panel">
        <h3>Deployment job</h3>
        <pre>{deployOutput || (imagesLoading ? 'Loading registry images...' : 'No deployment queued yet.')}</pre>
      </div>
    </section>
  );
}

function BuildImagePanel({
  imageName,
  dockerfilePath,
  buildLoading,
  buildMessage,
  buildOutput,
  buildJobId,
  imageTab,
  images,
  imagesLoading,
  imagesError,
  attachmentContainers,
  selectedImages,
  pendingDeleteImages,
  imageDeleteLoading,
  imageDeleteMessage,
  outputOpen,
  outputModalPosition,
  onImageNameChange,
  onDockerfilePathChange,
  onBuildImage,
  onStopBuild,
  onImageTabChange,
  onRefreshImages,
  onClearImageDeleteMessage,
  onSelectedImageChange,
  onConfirmDeleteImage,
  onAcceptDeleteImage,
  onRejectDeleteImage,
  onOpenOutput,
  onCloseOutput,
  onOutputModalDragStart,
  fileBrowserOpen,
  fileBrowserData,
  fileBrowserLoading,
  fileBrowserError,
  onOpenFileBrowser,
  onCloseFileBrowser,
  onBrowsePath,
  onSelectDockerfile,
  canOperate = () => true,
}) {
  const canBuildImages = canOperate('build_images');
  const canDeleteImages = canOperate('delete_images');

  return (
    <section className="home-panel build-image-panel">
      <PanelIntro
        title="Images"
        description="Build tagged images from a Dockerfile or remove images that are not in use."
      />
      <div className="resource-tabs" role="tablist" aria-label="Image actions">
        <button
          type="button"
          role="tab"
          aria-selected={imageTab === 'build'}
          className={imageTab === 'build' ? 'active' : ''}
          onClick={() => onImageTabChange('build')}
        >
          New image
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={imageTab === 'delete'}
          className={imageTab === 'delete' ? 'active' : ''}
          onClick={() => onImageTabChange('delete')}
        >
          Existing images
        </button>
      </div>

      {imageTab === 'build' ? (
        <form className="build-image-form" onSubmit={onBuildImage}>
          <label>
            <span>Image name</span>
            <input
              type="text"
              value={imageName}
              onChange={(event) => onImageNameChange(event.target.value)}
              placeholder="example: my-app:latest"
              disabled={buildLoading}
            />
          </label>

          <label>
            <span>Dockerfile path</span>
            <div className="path-picker-row">
              <input
                type="text"
                value={dockerfilePath}
                onChange={(event) => onDockerfilePathChange(event.target.value)}
                placeholder="/home/vitel/vitel-container/Dockerfile"
                disabled={buildLoading}
              />
              <button
                type="button"
                className="home-secondary-button"
                onClick={onOpenFileBrowser}
                disabled={buildLoading}
              >
                Browse
              </button>
            </div>
          </label>

          {buildMessage && <p className="build-message">{buildMessage}</p>}

          <div className="build-actions">
            <button
              type="submit"
              className="home-primary-button"
              disabled={!canBuildImages || buildLoading || !imageName.trim() || !dockerfilePath.trim()}
            >
              {buildLoading ? 'Building image...' : 'Build image'}
            </button>
            <button
              type="button"
              className="home-danger-button"
              onClick={onStopBuild}
              disabled={!buildLoading || !buildJobId}
            >
              Stop build
            </button>
            <button
              type="button"
              className="home-secondary-button"
              onClick={onOpenOutput}
            >
              View build output
            </button>
          </div>
        </form>
      ) : (
        <div className="resource-delete-panel">
          <div className="resource-delete-toolbar">
            <p>{selectedImages.length ? `Selected: ${selectedImages.length} image(s)` : 'Select one or more images to delete.'}</p>
            <button
              type="button"
              className="home-secondary-button"
              onClick={() => {
                onClearImageDeleteMessage();
                onRefreshImages();
              }}
              disabled={imagesLoading}
            >
              Refresh
            </button>
          </div>

          {imageDeleteMessage && <p className="build-message">{imageDeleteMessage}</p>}
          {imagesError && <p className="build-message error">{imagesError}</p>}
          {imagesLoading ? (
            <p className="resource-empty-state">Loading images...</p>
          ) : images.length ? (
            <div className="resource-table-wrap">
              <table className="resource-table">
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Image name</th>
                    <th>Image ID</th>
                    <th>Tag</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {images.map((image) => {
                    const id = getImageId(image);
                    const selected = selectedImages.some((selectedImage) => getImageId(selectedImage) === id);

                    return (
                      <tr key={id || getImageDisplayName(image)} className={selected ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            name="selected-image"
                            checked={selected}
                            onChange={() => onSelectedImageChange(image)}
                            aria-label={`Select ${getImageDisplayName(image)}`}
                          />
                        </td>
                        <td><ResourceAttachmentIndicator attached={isImageAttached(image, attachmentContainers)} label={getImageName(image)} /></td>
                        <td>{id}</td>
                        <td>{getImageTag(image)}</td>
                        <td>{image.Size || image.size || 'Unavailable'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="resource-empty-state">No Docker images found.</p>
          )}

          {selectedImages.length > 0 && (
            <div className="build-actions">
              <button
                type="button"
                className="home-danger-button"
                onClick={onConfirmDeleteImage}
                disabled={!canDeleteImages}
              >
                Delete selected images
              </button>
            </div>
          )}
        </div>
      )}

      {pendingDeleteImages.length > 0 && (
        <ImageDeleteModal
          images={pendingDeleteImages}
          loading={imageDeleteLoading}
          onAccept={onAcceptDeleteImage}
          onReject={onRejectDeleteImage}
        />
      )}

      {outputOpen && (
        <div className="output-modal-layer" role="presentation">
          <div
            className="output-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="build-output-title"
            style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
          onPointerDown={onOutputModalDragStart}
          >
            <div className="output-modal-heading draggable">
              <h3 id="build-output-title">Image build output</h3>
              {buildLoading && <span className="live-output-badge">Live</span>}
              <button
                type="button"
                onClick={onCloseOutput}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close output"
              >
                Close
              </button>
            </div>
            <pre>{buildOutput || 'No output yet.'}</pre>
          </div>
        </div>
      )}

      {fileBrowserOpen && (
        <FileBrowserModal
          data={fileBrowserData}
          loading={fileBrowserLoading}
          error={fileBrowserError}
          onBrowsePath={onBrowsePath}
          onSelectDockerfile={onSelectDockerfile}
          onClose={onCloseFileBrowser}
        />
      )}
    </section>
  );
}

function ImageDeleteModal({ images, loading, onAccept, onReject }) {
  return (
    <div className="output-modal-backdrop" role="presentation">
      <div className="resource-delete-modal" role="dialog" aria-modal="true" aria-labelledby="image-delete-title">
        <h3 id="image-delete-title">Delete selected images?</h3>
        <p>This will remove {images.length} Docker image(s). Images used by containers will stay protected.</p>
        <div className="resource-delete-list">
          {images.map((image) => (
            <dl key={getImageId(image)}>
              <div>
                <dt>Name</dt>
                <dd>{getImageDisplayName(image)}</dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd>{getImageId(image)}</dd>
              </div>
            </dl>
          ))}
        </div>
        <div className="resource-modal-actions">
          <button type="button" className="home-danger-button" onClick={onAccept} disabled={loading}>
            {loading ? 'Deleting...' : 'Delete'}
          </button>
          <button type="button" className="home-secondary-button" onClick={onReject} disabled={loading}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function getImageName(image) {
  return image?.Repository || image?.repository || image?.Name || image?.name || '<none>';
}

function getImageTag(image) {
  return image?.Tag || image?.tag || '<none>';
}

function getImageId(image) {
  return image?.ID || image?.Id || image?.id || 'Unavailable';
}

function getImageDisplayName(image) {
  const repository = getImageName(image);
  const tag = getImageTag(image);

  if (repository && repository !== '<none>' && tag && tag !== '<none>') {
    return `${repository}:${tag}`;
  }

  const id = getImageId(image);
  return repository && repository !== '<none>' ? repository : id;
}

function getImageReference(image) {
  const displayName = getImageDisplayName(image);
  return displayName && displayName !== 'Unavailable' ? displayName : getImageId(image);
}

function formatImageDeleteFailureMessage(deletedCount, failed) {
  const failureMessages = failed.map(({ result, image }) => {
    const name = getImageDisplayName(image);
    const backendMessage = result.reason?.response?.data?.output || result.reason?.response?.data?.error || '';
    const isInUse = /container is using|image is being used|conflict/i.test(backendMessage);

    if (isInUse) {
      return `Can't delete ${name}; this image is currently used by a container.`;
    }

    return backendMessage ? `Can't delete ${name}: ${backendMessage}` : `Can't delete ${name}.`;
  });

  if (deletedCount > 0) {
    return `Deleted ${deletedCount} image(s). ${failureMessages.join(' ')}`;
  }

  return failureMessages.join(' ');
}

function FileBrowserModal({
  data,
  loading,
  error,
  onBrowsePath,
  onSelectDockerfile,
  onClose,
}) {
  const directories = data?.directories || [];
  const dockerfiles = data?.dockerfiles || [];
  const dataError = data?.error;

  return (
    <div className="output-modal-backdrop" role="presentation">
      <div className="file-browser-modal" role="dialog" aria-modal="true" aria-labelledby="file-browser-title">
        <div className="output-modal-heading">
          <div>
            <h3 id="file-browser-title">Select Dockerfile</h3>
            <p>{data?.current_path || 'Loading server folders...'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close file browser">
            Close
          </button>
        </div>

        <div className="file-browser-body">
          {error && <p className="file-browser-error">{error}</p>}
          {dataError && <p className="file-browser-error">{dataError}</p>}
          {loading && <p className="file-browser-status">Loading...</p>}

          {data?.parent_path && (
            <button
              type="button"
              className="file-browser-row parent"
              onClick={() => onBrowsePath(data.parent_path)}
            >
              Back one folder
            </button>
          )}

          {directories.map((directory) => (
            <button
              type="button"
              className="file-browser-row"
              key={directory.path}
              onClick={() => onBrowsePath(directory.path)}
            >
              {directory.name}/
            </button>
          ))}

          {dockerfiles.map((dockerfile) => (
            <button
              type="button"
              className="file-browser-row dockerfile"
              key={dockerfile.path}
              onClick={() => onSelectDockerfile(dockerfile.path)}
            >
              {dockerfile.name}
            </button>
          ))}

          {!loading && directories.length === 0 && dockerfiles.length === 0 && !error && !dataError && (
            <p className="file-browser-status">No folders or Dockerfile files found here.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentPanel({
  mode,
  agentName,
  agentServerIp,
  agentPort,
  agentTab,
  agentLoading,
  agentDeleteLoading,
  agentRedeployLoading,
  agentMessage,
  agentCreateOutput,
  agentDeleteOutput,
  agentCreateOutputOpen,
  agentDeleteOutputOpen,
  outputModalPosition,
  agents,
  deletedAgents,
  agentsLoading,
  agentsError,
  selectedAgentId,
  selectedDeletedAgentId,
  onAgentNameChange,
  onAgentServerIpChange,
  onAgentPortChange,
  onAgentTabChange,
  onSelectedAgentChange,
  onSelectedDeletedAgentChange,
  onCreateAgent,
  onDeleteAgent,
  onRedeployAgent,
  onRefreshAgents,
  onOpenAgentCreateOutput,
  onCloseAgentCreateOutput,
  onOpenAgentDeleteOutput,
  onCloseAgentDeleteOutput,
  onOutputModalDragStart,
}) {
  const deletableAgents = agents.filter((agent) => agent.id !== 'local' && !agent.is_deleted);
  const restorableAgents = (deletedAgents || []).filter((agent) => agent.id !== 'local' && agent.is_deleted);
  const [agentOutputCopyMessage, setAgentOutputCopyMessage] = useState('');

  const getAgentSetupCommandText = (value) => {
    const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
    const startIndex = lines.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('docker pull ') || trimmed.startsWith('docker rm ') || trimmed.startsWith('docker run ');
    });
    if (startIndex === -1) {
      return String(value || '').trim();
    }

    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.startsWith('After the container starts, ')) {
        endIndex = index;
        break;
      }
    }

    return lines.slice(startIndex, endIndex).join('\n').trim();
  };

  const handleCopyAgentOutput = async (value, key, copyCommandsOnly = false) => {
    const text = copyCommandsOnly ? getAgentSetupCommandText(value) : String(value || '').trim();
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setAgentOutputCopyMessage(key);
      window.setTimeout(() => setAgentOutputCopyMessage(''), 1600);
    } catch (error) {
      setAgentOutputCopyMessage('failed');
      window.setTimeout(() => setAgentOutputCopyMessage(''), 2000);
    }
  };



  return (
    <section className="home-panel agent-panel">
      <PanelIntro
        title={mode === 'create' ? 'Add Server Agent' : 'Connected Servers'}
        description={mode === 'create' ? 'Register another Docker host with a privileged Docker agent command.' : 'Monitor every server that can be managed from this console.'}
      />

      {mode === 'create' ? (
        <>
          <div className="resource-tabs" role="tablist" aria-label="Agent actions">
            <button
              type="button"
              role="tab"
              aria-selected={agentTab === 'create'}
              className={agentTab === 'create' ? 'active' : ''}
              onClick={() => onAgentTabChange('create')}
            >
              New agent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={agentTab === 'delete'}
              className={agentTab === 'delete' ? 'active' : ''}
              onClick={() => {
                onAgentTabChange('delete');
                onRefreshAgents();
              }}
            >
              Manage agents
            </button>
          </div>

          {agentTab === 'create' ? (
            <form className="agent-form" onSubmit={onCreateAgent} autoComplete="off">
              <div className="agent-form-grid">
                <label>
                  <span>Display name</span>
                  <input
                    type="text"
                    name="agent-server-name"
                    value={agentName}
                    onChange={(event) => onAgentNameChange(event.target.value)}
                    placeholder="example: agent-01"
                    autoComplete="off"
                    disabled={agentLoading}
                  />
                </label>
                <label>
                  <span>Server address</span>
                  <input
                    type="text"
                    name="agent-server-ip"
                    value={agentServerIp}
                    onChange={(event) => onAgentServerIpChange(event.target.value)}
                    placeholder="example: 192.168.1.10"
                    autoComplete="off"
                    disabled={agentLoading}
                  />
                </label>
                <label>
                  <span>Agent service port</span>
                  <input
                    type="number"
                    name="agent-service-port"
                    min="1"
                    max="65535"
                    value={agentPort}
                    onChange={(event) => onAgentPortChange(event.target.value)}
                    autoComplete="off"
                    disabled={agentLoading}
                  />
                </label>
              </div>

              {agentMessage && <p className="container-message">{agentMessage}</p>}

              <div className="container-actions">
                <button
                  type="submit"
                  className="home-primary-button"
                  disabled={agentLoading || !agentName.trim() || !agentServerIp.trim()}
                >
                  {agentLoading ? 'Creating command...' : 'Create agent'}
                </button>
                <button
                  type="button"
                  className="home-secondary-button"
                  onClick={onOpenAgentCreateOutput}
                >
                  View setup output
                </button>
              </div>
            </form>
          ) : (
            <div className="agent-form">
              <div className="agent-management-grid">
                <label>
                  <span>Select existing agent</span>
                  <select
                    value={selectedAgentId}
                    onChange={(event) => onSelectedAgentChange(event.target.value)}
                    disabled={agentDeleteLoading || agentRedeployLoading || agentsLoading}
                  >
                    <option value="">Select agent</option>
                    {deletableAgents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name} ({agent.server_ip}:{agent.port || 19541})
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Select deleted agent</span>
                  <select
                    value={selectedDeletedAgentId}
                    onChange={(event) => onSelectedDeletedAgentChange(event.target.value)}
                    disabled={agentDeleteLoading || agentRedeployLoading || agentsLoading}
                  >
                    <option value="">Select deleted agent</option>
                    {restorableAgents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name} ({agent.server_ip}:{agent.port || 19541})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {agentMessage && <p className="container-message">{agentMessage}</p>}

              <div className="container-actions">
                <button
                  type="button"
                  className="home-danger-button"
                  disabled={!selectedAgentId || agentDeleteLoading || agentRedeployLoading}
                  onClick={() => onDeleteAgent(selectedAgentId)}
                >
                  {agentDeleteLoading ? 'Deleting agent...' : 'Delete selected agent'}
                </button>
                <button
                  type="button"
                  className="home-primary-button"
                  disabled={!selectedDeletedAgentId || agentDeleteLoading || agentRedeployLoading}
                  onClick={() => onRedeployAgent(selectedDeletedAgentId)}
                >
                  {agentRedeployLoading ? 'Redeploying agent...' : 'Redeploy selected agent'}
                </button>
                <button type="button" className="home-secondary-button" onClick={onRefreshAgents} disabled={agentsLoading || agentRedeployLoading}>
                  Refresh
                </button>
                <button
                  type="button"
                  className="home-secondary-button"
                  onClick={onOpenAgentDeleteOutput}
                >
                  View management output
                </button>
              </div>
            </div>
          )}

          {agentCreateOutputOpen && (
            <div className="output-modal-layer" role="presentation">
              <div
                className="output-modal agent-setup-output-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="agent-create-output-title"
                style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
              onPointerDown={onOutputModalDragStart}
              >
                <div className="output-modal-heading draggable">
                  <h3 id="agent-create-output-title">Agent setup output</h3>
                  {agentLoading && <span className="live-output-badge">Live</span>}
                  {agentOutputCopyMessage === 'create' && <span className="live-output-badge">Copied</span>}
                  {agentOutputCopyMessage === 'failed' && <span className="live-output-badge">Copy failed</span>}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCopyAgentOutput(agentCreateOutput, 'create', true);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    disabled={!agentCreateOutput}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={onCloseAgentCreateOutput}
                    onPointerDown={(event) => event.stopPropagation()}
                    aria-label="Close output"
                  >
                    Close
                  </button>
                </div>
                <pre>{agentCreateOutput || 'No output yet.'}</pre>
              </div>
            </div>
          )}

          {agentDeleteOutputOpen && (
            <div className="output-modal-layer" role="presentation">
              <div
                className="output-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="agent-delete-output-title"
                style={{ transform: `translate(${outputModalPosition.x}px, ${outputModalPosition.y}px)` }}
              onPointerDown={onOutputModalDragStart}
              >
                <div className="output-modal-heading draggable">
                  <h3 id="agent-delete-output-title">Agent management output</h3>
                  {(agentDeleteLoading || agentRedeployLoading) && <span className="live-output-badge">Live</span>}
                  {agentOutputCopyMessage === 'delete' && <span className="live-output-badge">Copied</span>}
                  {agentOutputCopyMessage === 'failed' && <span className="live-output-badge">Copy failed</span>}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCopyAgentOutput(agentDeleteOutput, 'delete');
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    disabled={!agentDeleteOutput}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={onCloseAgentDeleteOutput}
                    onPointerDown={(event) => event.stopPropagation()}
                    aria-label="Close output"
                  >
                    Close
                  </button>
                </div>
                <pre>{agentDeleteOutput || 'No output yet.'}</pre>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="connected-agent-panel">
          <div className="resource-delete-toolbar">
            <p>{agentsError ? 'Unable to load agents.' : (agents.length ? `${agents.length} server(s) available.` : 'No connected agents found.')}</p>
            <button type="button" className="home-secondary-button" onClick={onRefreshAgents} disabled={agentsLoading}>
              Refresh
            </button>
          </div>

          {agentsError && <p className="build-message error">{agentsError}</p>}
          {agentsLoading ? (
            <p className="resource-empty-state">Loading agents...</p>
          ) : agents.length ? (
            <div className="agent-grid">
              {agents.map((agent) => {
                const status = getAgentStatus(agent);
                return (
                  <article className="agent-card" key={agent.id || agent.name}>
                    <div className="agent-card-heading">
                      <h3>{agent.name}</h3>
                      <span className={status.className}>{status.label}</span>
                    </div>
                    <dl>
                    <div>
                      <dt>Server IP</dt>
                      <dd>{agent.server_ip || 'Unavailable'}</dd>
                    </div>
                    <div>
                      <dt>Host</dt>
                      <dd>{agent.hostname || 'Unavailable'}</dd>
                    </div>
                    <div>
                      <dt>Containers</dt>
                      <dd>{agent.containers_count ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Images</dt>
                      <dd>{agent.images_count ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Networks</dt>
                      <dd>{agent.networks_count ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Volumes</dt>
                      <dd>{agent.volumes_count ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Last seen</dt>
                      <dd>{agent.last_seen || 'Current server'}</dd>
                    </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          ) : agentsError ? null : (
            <p className="resource-empty-state">No connected agents found.</p>
          )}
        </div>
      )}
    </section>
  );
}


function OperationSelect({ operations, value, onChange, disabled }) {
  const selectedValues = Array.isArray(value) ? value : [];
  const selected = new Set(selectedValues);
  const operationCodes = operations.map((operation) => operation.code);
  const administratorSelected = selected.has('administrator');
  const selectedCount = operationCodes.filter((code) => selected.has(code)).length;
  const selectedSummary = administratorSelected ? 'Full access' : `${selectedCount} selected`;
  const allSelected = operations.length > 0 && (administratorSelected || selectedCount === operations.length);

  const handleOperationChange = (code, checked) => {
    if (code === 'administrator') {
      onChange(checked ? ['administrator'] : []);
      return;
    }

    const next = new Set(selectedValues.filter((selectedCode) => selectedCode !== 'administrator'));
    if (checked) {
      next.add(code);
    } else {
      next.delete(code);
    }
    onChange(operationCodes.filter((operationCode) => next.has(operationCode)));
  };

  return (
    <div className={`rbac-operation-picker${disabled ? ' disabled' : ''}`}>
      <div className="rbac-operation-toolbar">
        <span>{selectedSummary}</span>
        <div>
          <button type="button" className="home-secondary-button" onClick={() => onChange(['administrator'])} disabled={disabled || allSelected || !operations.length}>Select all</button>
          <button type="button" className="home-secondary-button" onClick={() => onChange([])} disabled={disabled || selectedCount === 0}>Clear</button>
        </div>
      </div>
      <div className="rbac-operation-options" role="group" aria-label="Operations list">
        {operations.length ? operations.map((operation) => {
          const checked = selected.has(operation.code);
          return (
            <label className={`rbac-operation-option${checked ? ' selected' : ''}`} key={operation.code}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => handleOperationChange(operation.code, event.target.checked)}
                disabled={disabled}
              />
              <span>{operation.label}</span>
            </label>
          );
        }) : <span className="rbac-empty-permission">No operations available</span>}
      </div>
    </div>
  );
}

function OperationBadges({ codes, labelByCode, fallback = 'No operations selected' }) {
  const values = Array.isArray(codes) ? codes : [];
  if (!values.length) {
    return <span className="rbac-empty-permission">{fallback}</span>;
  }

  return (
    <div className="rbac-permission-list">
      {values.map((code) => (
        <span className="rbac-permission-chip" key={code}>{labelByCode.get(code) || code}</span>
      ))}
    </div>
  );
}

function RbacPanel({
  rbacTab,
  rbacData,
  rbacLoading,
  rbacMessage,
  rbacUsername,
  rbacPassword,
  rbacConfirmPassword,
  rbacUserGroupId,
  rbacUserOperations,
  rbacGroupName,
  rbacGroupOperations,
  canCreateRbacUser,
  canCreateRbacGroup,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onUserGroupChange,
  onUserOperationsChange,
  onGroupNameChange,
  onGroupOperationsChange,
  onCreateUser,
  onCreateGroup,
  onDeleteItem,
  onRefresh,
}) {
  const operations = rbacData.operations || [];
  const users = rbacData.users || [];
  const groups = rbacData.groups || [];
  const labelByCode = new Map(operations.map((operation) => [operation.code, operation.label]));
  const activeRbacTab = rbacTab === 'user' && !canCreateRbacUser && canCreateRbacGroup
    ? 'group'
    : rbacTab === 'group' && !canCreateRbacGroup && canCreateRbacUser
      ? 'user'
      : rbacTab;

  return (
    <section className="home-panel rbac-panel">
      <div className="rbac-heading">
        <div>
          <h2>Users & Access</h2>
          <p>Create scoped users and reusable groups without changing existing accounts.</p>
        </div>
        <button type="button" className="home-secondary-button" onClick={onRefresh} disabled={rbacLoading}>Refresh</button>
      </div>

      <div className="rbac-mode-heading">
        <span>{activeRbacTab === 'user' ? 'New user' : 'New group'}</span>
        <p>{activeRbacTab === 'user' ? 'Create one login and choose its access.' : 'Create one reusable permission group.'}</p>
      </div>

      {rbacMessage && <p className="container-message">{rbacMessage}</p>}

      {activeRbacTab === 'user' ? (
        <form className="agent-form rbac-form" onSubmit={onCreateUser}>
          <div className="agent-form-grid">
            <label><span>Username</span><input value={rbacUsername} onChange={(event) => onUsernameChange(event.target.value)} disabled={rbacLoading} autoComplete="username" /></label>
            <label><span>Password</span><input type="password" value={rbacPassword} onChange={(event) => onPasswordChange(event.target.value)} disabled={rbacLoading} autoComplete="new-password" /></label>
            <label><span>Confirm password</span><input type="password" value={rbacConfirmPassword} onChange={(event) => onConfirmPasswordChange(event.target.value)} disabled={rbacLoading} autoComplete="new-password" /></label>
            <label>
              <span>Access group</span>
              <select value={rbacUserGroupId} onChange={(event) => onUserGroupChange(event.target.value)} disabled={rbacLoading}>
                <option value="">No group</option>
                {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
              </select>
              <small className="field-help">Choose a group to inherit its operations. Direct operations are disabled while a group is selected.</small>
            </label>
            <label className="rbac-operation-field">
              <span>Allowed operations</span>
              <OperationSelect operations={operations} value={rbacUserOperations} onChange={onUserOperationsChange} disabled={rbacLoading || Boolean(rbacUserGroupId)} />
            </label>
          </div>
          <div className="container-actions">
            <button type="submit" className="home-primary-button" disabled={rbacLoading || !rbacUsername.trim() || !rbacPassword || !rbacConfirmPassword}>Create user</button>
          </div>
        </form>
      ) : (
        <form className="agent-form rbac-form" onSubmit={onCreateGroup}>
          <div className="agent-form-grid">
            <label><span>Group name</span><input value={rbacGroupName} onChange={(event) => onGroupNameChange(event.target.value)} disabled={rbacLoading} /></label>
            <label className="rbac-operation-field"><span>Allowed operations</span><OperationSelect operations={operations} value={rbacGroupOperations} onChange={onGroupOperationsChange} disabled={rbacLoading} /></label>
          </div>
          <div className="container-actions">
            <button type="submit" className="home-primary-button" disabled={rbacLoading || !rbacGroupName.trim()}>Create group</button>
          </div>
        </form>
      )}

      <div className="rbac-list-heading">
        <h3>{activeRbacTab === 'user' ? 'Users' : 'Groups'}</h3>
      </div>

      {activeRbacTab === 'user' ? (
        <div className="rbac-list-panel">
          {users.length ? users.map((user) => {
            const groupNames = user.groups?.map((group) => group.name).join(', ');
            const inheritedFromGroup = Boolean(groupNames);
            return (
              <article className="rbac-list-item" key={user.id}>
                <div className="rbac-list-main">
                  <div>
                    <strong>{user.username}</strong>
                    <small>{user.is_admin ? 'Administrator' : inheritedFromGroup ? `Group: ${groupNames}` : user.operations_configured ? 'Direct permissions' : 'Existing user - unchanged'}</small>
                  </div>
                  <OperationBadges codes={user.operations} labelByCode={labelByCode} fallback={user.operations_configured ? 'No operations selected' : 'All operations'} />
                </div>
                <button type="button" className="home-danger-button" onClick={() => onDeleteItem('user', user.id)} disabled={rbacLoading || user.is_admin || !canCreateRbacUser}>Delete</button>
              </article>
            );
          }) : <p className="resource-empty-state">No created users found.</p>}
        </div>
      ) : (
        <div className="rbac-list-panel">
          {groups.length ? groups.map((group) => (
            <article className="rbac-list-item" key={group.id}>
              <div className="rbac-list-main">
                <div>
                  <strong>{group.name}</strong>
                  <small>{group.user_count || 0} user(s)</small>
                </div>
                <OperationBadges codes={group.operations} labelByCode={labelByCode} />
              </div>
              <button type="button" className="home-danger-button" onClick={() => onDeleteItem('group', group.id)} disabled={rbacLoading || !canCreateRbacGroup}>Delete</button>
            </article>
          )) : <p className="resource-empty-state">No created groups found.</p>}
        </div>
      )}
    </section>
  );
}

function ServerInfoPanel({ serverInfo, loading, error, onRefresh }) {
  const onBackToDashboard = useContext(DashboardBackContext);

  if (loading) {
    return (
      <section className="home-panel">
        <h2>Server Health</h2>
        <p>Loading server information...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="home-panel">
        <h2>Server Health</h2>
        <p>{error}</p>
        <button type="button" className="home-primary-button" onClick={onRefresh}>
          Retry
        </button>
      </section>
    );
  }

  if (!serverInfo) {
    return null;
  }

  const sections = [
    ['Operating System', serverInfo.operating_system],
    ['Resources', serverInfo.resources],
    ['Docker Summary', serverInfo.docker],
  ];

  return (
    <section className="server-info-panel">
      <div className="server-info-heading">
        <div>
          <h2>Server Health</h2>
          <p>Updated every 1 minute. Last checked at {serverInfo.checked_at}</p>
        </div>
        <div className="server-info-actions">
          <button type="button" className="home-primary-button" onClick={onRefresh}>
            Refresh
          </button>
          {onBackToDashboard ? (
            <button type="button" className="home-secondary-button dashboard-back-button" onClick={onBackToDashboard}>
              Back to Dashboard
            </button>
          ) : null}
        </div>
      </div>

      <div className="server-info-grid">
        {sections.map(([title, values]) => (
          <article className="server-info-card" key={title}>
            <h3>{title}</h3>
            <dl>
              {Object.entries(values || {}).map(([key, value]) => (
                <div key={key}>
                  <dt>{formatLabel(key)}</dt>
                  <dd>{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatLabel(label) {
  return label.replaceAll('_', ' ');
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : 'Unavailable';
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, nestedValue]) => `${formatLabel(key)}: ${nestedValue}`)
      .join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return value || 'Unavailable';
}
