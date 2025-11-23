import 'react-native-gesture-handler';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { api, initializeApp, setApiBaseUrl, getApiDiagnostics } from '../lib/api';
import LocationPermissionService from '../services/LocationPermissionService';
import { useAuth } from '../contexts/AuthContext';

// Login screen at /login
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const router = useRouter();
  const { login } = useAuth();

  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('checking'); // checking | connected | failed
  const [apiBase, setApiBase] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [overrideInput, setOverrideInput] = useState('');

  useEffect(() => {
    (async () => {
      const connected = await initializeApp();
      setConnectionStatus(connected ? 'connected' : 'failed');
      const diag = getApiDiagnostics();
      setApiBase(diag.API_BASE_URL);
      setOverrideInput(diag.API_BASE_URL);
    })();
  }, []);

  const handleLogin = async () => {
    if (connectionStatus === 'failed') {
      Alert.alert(
        'Connection Error',
        `Cannot connect to server. Please check:\n\n• Backend is running\n• Correct IP address in lib/api.js\n• Same WiFi network`,
        [{ text: 'OK' }]
      );
      return;
    }

    if (!email || !password) {
      Alert.alert('Error', 'Please enter both email and password.');
      return;
    }
    setLoading(true);
    try {
      console.log('🔄 Attempting login...');
      const resp = await api.login(email, password);
      
      if (resp.success && resp.user) {
        console.log('✅ Login successful, storing user data');
        // Transform user data to match expected format
        const transformedUser = {
          Account_id: resp.user.id,
          Fullname: resp.user.fullname,
          Username: resp.user.username,
          Email: resp.user.email,
          Role: resp.user.role,
          EmployeeID: resp.user.employeeId,
          Contact: resp.user.contact,
          Address: resp.user.address,
          BranchID: resp.user.branchId,
          Photo: resp.user.photo
        };
        // Store user data using AuthContext
        await login(transformedUser);
        // Prompt for location permission right after successful login
        try {
          const ready = await LocationPermissionService.ensureAfterLogin();
          if (!ready) {
            // Non-blocking: user can enable later from settings
            console.log('Location not ready yet; proceeding to dashboard');
          }
        } catch {}
        // Navigate to dashboard
        console.log('✅ Navigating to dashboard');
        router.replace('/dashboard');
      } else {
        throw new Error(resp.message || 'Login failed');
      }
    } catch (e) {
      console.error('Login error:', e);
      Alert.alert('Login Failed', e.message || 'An error occurred during login');
    } finally {
      setLoading(false);
    }
  };

  const connectionMessage = connectionStatus === 'checking'
    ? 'Checking connection...'
    : connectionStatus === 'connected'
    ? '\u2705 Connected to server'
    : connectionStatus === 'failed'
    ? '\u274C Cannot connect to server'
    : '';

  const applyOverride = () => {
    if (!overrideInput.trim()) return;
    const updated = setApiBaseUrl(overrideInput.trim());
    setApiBase(updated);
    Alert.alert('API Base Updated', updated);
  };

  return (
    <View style={styles.background}>
      <View style={styles.overlay}>
        <Image
          source={require('../assets/mze.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.appTitle}></Text>

        {/* Connection status indicator */}
        <View style={[styles.connectionStatus,
          connectionStatus === 'connected' && styles.connected,
          connectionStatus === 'failed' && styles.failed
        ]}>
          <Text style={styles.connectionText}>{connectionMessage}</Text>
          <TouchableOpacity onLongPress={() => setShowDebug(s => !s)}>
            <Text style={styles.debugToggle}>↕ Debug {showDebug ? '▲' : '▼'}</Text>
          </TouchableOpacity>
          {showDebug && (
            <View style={styles.debugBox}>
              <Text style={styles.debugLabel}>API Base:</Text>
              <Text style={styles.debugValue}>{apiBase}</Text>
              <TextInput
                style={styles.debugInput}
                value={overrideInput}
                onChangeText={setOverrideInput}
                placeholder="http://host:port/api"
                placeholderTextColor="#ccc"
                autoCapitalize="none"
              />
              <TouchableOpacity style={styles.debugButton} onPress={applyOverride}>
                <Text style={styles.debugButtonText}>Apply Override</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#fff"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#fff"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity
          style={[styles.button, (loading || connectionStatus === 'failed') && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading || connectionStatus === 'failed'}
        >
          <Text style={styles.buttonText}>{loading ? 'Logging in...' : 'Login'}</Text>
        </TouchableOpacity>

        
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  background: {
    flex: 1,
    backgroundColor: '#4B0082',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: {
    width: 900,
    height: 210,
    marginBottom: 0,
  },
  overlay: {
    width: '75%',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
  },
  appTitle: {
    color: '#FFD700',
    fontSize: 26,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  input: {
    width: '100%',
    height: 50,
    borderColor: '#fff',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
    fontSize: 16,
    color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  button: {
    width: '100%',
    backgroundColor: '#8A2BE2',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: '#FFD700',
    fontSize: 18,
    fontWeight: 'bold',
  },
  // Connection status styles
  connectionStatus: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 16,
    alignItems: 'center',
  },
  connected: {
    backgroundColor: 'rgba(0, 255, 0, 0.2)',
  },
  failed: {
    backgroundColor: 'rgba(255, 0, 0, 0.2)',
  },
  connectionText: {
    color: '#fff',
    fontWeight: '600',
  },
  debugToggle: {
    marginTop: 4,
    color: '#FFD700',
    fontSize: 12,
  },
  debugBox: {
    marginTop: 8,
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  debugLabel: {
    color: '#FFD700',
    fontSize: 12,
    marginBottom: 4,
    fontWeight: '600'
  },
  debugValue: {
    color: '#fff',
    fontSize: 12,
    marginBottom: 8,
  },
  debugInput: {
    width: '100%',
    height: 40,
    borderColor: '#fff',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    color: '#fff',
    fontSize: 12,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.15)'
  },
  debugButton: {
    backgroundColor: '#8A2BE2',
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center'
  },
  debugButtonText: {
    color: '#FFD700',
    fontSize: 13,
    fontWeight: '600'
  }
});
