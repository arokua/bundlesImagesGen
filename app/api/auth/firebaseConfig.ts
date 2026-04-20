// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDLlc-qAHYlZ5lTM-oBQ6p523UQs9U30lY",
  authDomain: "qtoys-bundle-image-generator.firebaseapp.com",
  projectId: "qtoys-bundle-image-generator",
  storageBucket: "qtoys-bundle-image-generator.firebasestorage.app",
  messagingSenderId: "902507237523",
  appId: "1:902507237523:web:7542877d25d0d0651b7d66",
  measurementId: "G-G50XH6JW5P"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);