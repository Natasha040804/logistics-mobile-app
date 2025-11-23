import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// Mutable base URL so we can update after runtime detection
// Initial fallback; prefer env-provided full base (EXPO_PUBLIC_API_BASE) or host (EXPO_PUBLIC_API_HOST)
// NOTE: Include port 5000 explicitly to match backend listening configuration
// If you place a reverse proxy (e.g. Nginx) on :80 -> :5000 you can switch this to http://16.176.194.83/api
let API_BASE_URL = 'http://16.176.194.83:5000/api'; // primary (expects reverse proxy / opened port 80)
// We will auto-fallback to :5000 if direct host:80 fails.


// Probe candidate hosts for /api/health until one responds
export const detectApiBaseUrl = async () => {
  // If a full base URL is provided (includes protocol & /api), trust it immediately.
  const envBase = typeof process !== 'undefined' ? (process.env?.EXPO_PUBLIC_API_BASE) : undefined;
  if (envBase && /^https?:\/\//.test(envBase)) {
    API_BASE_URL = envBase.replace(/\/$/, '');
    console.log(`✅ Using explicit API base: ${API_BASE_URL}`);
    return API_BASE_URL;
  }
  // Allow ENV host override (without protocol) eg: EXPO_PUBLIC_API_HOST=api.example.com
  const envHost = typeof process !== 'undefined' ? (process.env?.EXPO_PUBLIC_API_HOST || process.env?.API_HOST) : undefined;
  // Try to derive the developer machine (Metro) host from Expo constants
  let packagerHost = null;
  try {
    const hostUri = Constants?.expoConfig?.hostUri
      || Constants?.manifest2?.extra?.expoGo?.debuggerHost
      || Constants?.manifest?.debuggerHost;
    if (hostUri && typeof hostUri === 'string') {
      packagerHost = hostUri.split(':')[0];
    }
  } catch {}

  const emulatorHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  const storedHost = await AsyncStorage.getItem('lastApiHost').catch(() => null);

  const candidates = [
    envHost,
    storedHost,
    packagerHost,
    '16.176.194.83', // current network (adjustable)
    '16.176.194.83', // previous/home network
    emulatorHost,
    'localhost'
  ].filter(Boolean);

  const tryHost = async (host) => {
    const variants = [
      { base: `http://${host}/api`, health: `http://${host}/api/health` },
      { base: `http://${host}:5000/api`, health: `http://${host}:5000/api/health` },
      // Prefer https variants if certificate is present (will just fail fast if not)
      { base: `https://${host}/api`, health: `https://${host}/api/health` },
      { base: `https://${host}:5000/api`, health: `https://${host}:5000/api/health` },
    ];
    for (const v of variants) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500); // allow slower mobile networks
      try {
        console.log(`🔎 Probing ${v.health}`);
        const res = await fetch(v.health, { signal: controller.signal });
        if (res.ok) {
          API_BASE_URL = v.base.replace(/\/$/, '');
          await AsyncStorage.setItem('lastApiHost', host).catch(() => {});
          console.log(`✅ API host detected: ${API_BASE_URL}`);
          return true;
        } else {
          console.log(`⚠️ Health endpoint not OK (${res.status}) for ${v.health}`);
        }
      } catch (e) {
        console.log(`❌ Probe failed for ${v.health}: ${e?.message || e}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return false;
  };

  for (const host of candidates) {
    const ok = await tryHost(host);
    if (ok) return API_BASE_URL;
  }
  console.warn('⚠️ API host detection failed. Using fallback:', API_BASE_URL);
  return API_BASE_URL;
};

// Helper to get auth headers with user ID (for header-based endpoints)
const getAuthHeaders = async () => {
  try {
    const userData = await AsyncStorage.getItem('userData');
    if (userData) {
      const user = JSON.parse(userData);
      return {
        'Content-Type': 'application/json',
        ...(user?.Account_id ? { 'X-User-Id': String(user.Account_id) } : {}),
      };
    }
  } catch (error) {
    console.error('Error getting auth headers:', error);
  }
  return { 'Content-Type': 'application/json' };
};

const api = {
  async request(endpoint, options = {}) {
    console.log(`🔄 API Call: ${API_BASE_URL}${endpoint}`);
    let token;
    try {
      token = await AsyncStorage.getItem('accessToken');
    } catch (error) {
      console.warn('Storage error:', error);
    }

    const config = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      ...(options.body
        ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }
        : {}),
    };

    // 10s timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...config, signal: controller.signal });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) {
        const message = text ? `HTTP ${response.status}: ${text}` : `Request failed (${response.status})`;
        throw new Error(message);
      }
      return data;
    } catch (error) {
      console.error('❌ API Request Failed:', { url: `${API_BASE_URL}${endpoint}`, error: error?.message || String(error) });
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out (10s) contacting ${API_BASE_URL}.`);
      }
      if ((error.message || '').includes('Network request failed')) {
        throw new Error(
          `Cannot connect to server at ${API_BASE_URL}. Please check:\n` +
          '1. Backend server is running\n' +
          '2. Correct IP address\n' +
          '3. Both devices on same network'
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  async refreshToken() {
    const refreshToken = await AsyncStorage.getItem('refreshToken');
    if (!refreshToken) throw new Error('No refresh token');
    const res = await fetch(`${API_BASE_URL}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) throw new Error('Failed to refresh token');
    const { accessToken } = await res.json();
    return accessToken;
  },

  async clearAuth() {
    await AsyncStorage.multiRemove(['accessToken', 'refreshToken', 'userData']);
  },

  async login(email, password) {
    // Simpler login hitting /auth/login and returning response as-is
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      let errorData = {};
      try { errorData = await response.json(); } catch {}
      throw new Error(errorData.message || errorData.error || 'Login failed');
    }
    const data = await response.json();
    return data;
  },

  async logout() {
    try { await this.request('/logout', { method: 'POST' }); } catch {}
    await this.clearAuth();
  },

  async isAuthenticated() {
    const token = await AsyncStorage.getItem('accessToken');
    const userData = await AsyncStorage.getItem('userData');
    if (!token || !userData) return false;
    try {
      const payload = JSON.parse(
        typeof atob !== 'undefined'
          ? atob(token.split('.')[1])
          : Buffer.from(token.split('.')[1], 'base64').toString('utf8')
      );
      return payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  },

  async getCurrentUser() {
    const userData = await AsyncStorage.getItem('userData');
    return userData ? JSON.parse(userData) : null;
  },

  // Example data methods used by screens
  async getDashboardData() { return this.request('/dashboard'); },
  async getDeliveryDetails(id) { return this.request(`/deliveries/${id}`); },
  async getUserProfile() { return this.request('/profile'); },
  
  // Delivery assignments APIs
  async getDeliveryAssignments() {
    return this.request('/delivery-assignments');
  },

  async getDeliveryAssignment(id) {
    const res = await this.request(`/delivery-assignments/${id}`);
    // Backend wraps single assignment as { success:true, data: {...} }
    if (res && typeof res === 'object') {
      if ('data' in res && res.success) return res.data;
    }
    return res;
  },

  async updateDeliveryStatus(assignmentId, status, notes = '') {
    return this.request(`/delivery-assignments/${assignmentId}/status`, {
      method: 'PUT',
      body: { status, notes },
    });
  },

  // Update driver current GPS location for an assignment (use schema-flexible endpoint)
  async updateDeliveryLocation(assignmentId, payload) {
    // payload: { latitude, longitude, accuracy?, heading?, speed?, timestamp? }
    const body = {
      assignment_id: Number(assignmentId),
      latitude: payload?.latitude,
      longitude: payload?.longitude,
      accuracy: payload?.accuracy,
      // Prefer recorded_at to match existing DB schema; backend will fallback if needed
      recorded_at: payload?.timestamp || new Date().toISOString(),
    };
    return this.request(`/delivery-locations`, {
      method: 'POST',
      body,
    });
  },

  async verifyPickup(assignmentId, itemImage) {
    const headers = await getAuthHeaders();
    const formData = new FormData();
    if (itemImage) {
      formData.append('itemImage', {
        uri: itemImage.uri,
        type: 'image/jpeg',
        name: 'pickup.jpg',
      });
    }
    delete headers['Content-Type'];
    const response = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-pickup`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Pickup failed');
    }
    return data;
  },

  async verifyDropoff(assignmentId, itemImage) {
    const headers = await getAuthHeaders();
    const formData = new FormData();
    if (itemImage) {
      formData.append('itemImage', {
        uri: itemImage.uri,
        type: 'image/jpeg',
        name: 'dropoff.jpg',
      });
    }
    delete headers['Content-Type'];
    const response = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-dropoff`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Dropoff failed');
    }
    return data;
  },

  // User-scoped lists
  async getMyAssignments() {
    // Use shared request to include Authorization automatically and pass X-User-Id
    const headers = await getAuthHeaders();
    // Avoid overriding Authorization or Content-Type from request()
    delete headers['Content-Type'];
    return this.request('/delivery-assignments/my-assignments', { headers });
  },

  async getMyCompletedDeliveries() {
    // Use shared request to include Authorization automatically and pass X-User-Id
    const headers = await getAuthHeaders();
    delete headers['Content-Type'];
    return this.request('/delivery-assignments/my-completed', { headers });
  },
  
  // Multipart alternatives to support image file uploads (do not set Content-Type manually)
  async verifyPickupMultipart(assignmentId, { file, location, notes }) {
    const token = await AsyncStorage.getItem('accessToken');
    const form = new FormData();
    if (file) {
      form.append('itemImage', {
        uri: file.uri,
        type: file.type || 'image/jpeg',
        name: file.name || 'item.jpg',
      });
    }
    if (location) {
      form.append('location', JSON.stringify(location));
      if (typeof location.lat !== 'undefined') form.append('latitude', String(location.lat));
      if (typeof location.lng !== 'undefined') form.append('longitude', String(location.lng));
      if (typeof location.latitude !== 'undefined') form.append('latitude', String(location.latitude));
      if (typeof location.longitude !== 'undefined') form.append('longitude', String(location.longitude));
    }
    if (notes) form.append('notes', notes);
    const res = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-pickup`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  },

  async verifyDropoffMultipart(assignmentId, { file, recipientName, location, notes }) {
    const token = await AsyncStorage.getItem('accessToken');
    const form = new FormData();
    if (file) {
      form.append('itemImage', {
        uri: file.uri,
        type: file.type || 'image/jpeg',
        name: file.name || 'dropoff.jpg',
      });
    }
    if (recipientName) form.append('recipient_name', recipientName);
    if (location) {
      form.append('location', JSON.stringify(location));
      if (typeof location.lat !== 'undefined') form.append('latitude', String(location.lat));
      if (typeof location.lng !== 'undefined') form.append('longitude', String(location.lng));
      if (typeof location.latitude !== 'undefined') form.append('latitude', String(location.latitude));
      if (typeof location.longitude !== 'undefined') form.append('longitude', String(location.longitude));
    }
    if (notes) form.append('notes', notes);
    const res = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-dropoff`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  },
 
  async testConnection() {
    console.log('🔍 Testing connection to:', API_BASE_URL);
    // Try primary health first
    const healthUrls = [
      `${API_BASE_URL}/health`,
      // If current base is no-port form, also probe :5000
      API_BASE_URL.includes(':5000') ? null : `${API_BASE_URL.replace('/api','')}:5000/api/health`,
    ].filter(Boolean);
    const failures = [];
    for (const h of healthUrls) {
      try {
        const res = await fetch(h, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
        if (res.ok) {
          try { await res.json(); } catch {}
          console.log(`✅ Connection test successful via ${h}`);
          // If success came from :5000 and base lacks :5000, adjust
          if (h.includes(':5000') && !API_BASE_URL.includes(':5000')) {
            API_BASE_URL = `${API_BASE_URL.replace('/api','')}:5000/api`;
            console.log('🔁 Updated API_BASE_URL to explicit port 5000:', API_BASE_URL);
          }
          return true;
        }
      } catch (error) {
        const msg = error?.message || String(error);
        failures.push({ url: h, error: msg });
        console.warn(`⚠️ Health probe failed for ${h}:`, msg);
      }
    }
    console.error('❌ All health probes failed for base:', API_BASE_URL);
    if (failures.length) {
      console.log('📋 Failure summary:', failures);
    }
    return false;
  },
};

export const initializeApp = async () => {
  // Attempt proactive host detection first
  await detectApiBaseUrl();
  let isConnected = await api.testConnection();
  if (!isConnected) {
    // Second chance: re-run detection in case network changed post-launch
    await detectApiBaseUrl();
    isConnected = await api.testConnection();
  }
  if (!isConnected) {
    console.log('⚠️ API unreachable. Edit host or ensure backend running.');
  }
  return isConnected;
};

// Manual override helper (e.g., invoked from a hidden settings/debug screen)
export const setApiBaseUrl = (url) => {
  if (typeof url === 'string' && url.trim()) {
    API_BASE_URL = url.replace(/\/$/, '');
    AsyncStorage.setItem('lastApiHost', API_BASE_URL.split('://')[1]?.split('/')[0] || '').catch(() => {});
    console.log('🔧 Manual API_BASE_URL override:', API_BASE_URL);
  }
  return API_BASE_URL;
};

export const getApiDiagnostics = () => ({ API_BASE_URL });

export { api, API_BASE_URL };
// Simplified named exports for image-only verification via multipart/form-data
export const verifyPickup = async (assignmentId, itemImage) => {
  const token = await AsyncStorage.getItem('accessToken');
  const formData = new FormData();
  if (itemImage) {
    formData.append('itemImage', {
      uri: itemImage.uri,
      type: itemImage.type || 'image/jpeg',
      name: itemImage.name || 'pickup.jpg',
    });
  }
  const res = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-pickup`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error((data && data.error) || text || 'Pickup failed');
  }
  return data;
};

export const verifyDropoff = async (assignmentId, itemImage) => {
  const token = await AsyncStorage.getItem('accessToken');
  const formData = new FormData();
  if (itemImage) {
    formData.append('itemImage', {
      uri: itemImage.uri,
      type: itemImage.type || 'image/jpeg',
      name: itemImage.name || 'dropoff.jpg',
    });
  }
  const res = await fetch(`${API_BASE_URL}/delivery-assignments/${assignmentId}/verify-dropoff`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error((data && data.error) || text || 'Dropoff failed');
  }
  return data;
};

// Get completed deliveries (public endpoint in current setup)
export const getCompletedDeliveries = async () => {
  const res = await fetch(`${API_BASE_URL}/delivery-assignments/completed`);
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: Failed to fetch completed deliveries`);
  }
  return data || [];
};

// Get active assignments (ASSIGNED and IN_PROGRESS only)
export const getActiveAssignments = async () => {
  const res = await fetch(`${API_BASE_URL}/delivery-assignments/active`);
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: Failed to fetch active assignments`);
  }
  return data || [];
};
