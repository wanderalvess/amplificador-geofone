// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBSP2i3sNCvn5nEdDoUV5zlVbIdxF95kxE",
  authDomain: "geofone-app.firebaseapp.com",
  projectId: "geofone-app",
  storageBucket: "geofone-app.firebasestorage.app",
  messagingSenderId: "804862645818",
  appId: "1:804862645818:web:918388be3f3fe25b234703",
  measurementId: "G-8QRXX2CPSC"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Initialize Analytics safely
export let analytics = null;
if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) {
      analytics = getAnalytics(app);
    }
  });
}
