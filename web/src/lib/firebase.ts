import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyB-fxe-Ife_AUnIO8PWwxVfQheIeZIPQfw",
  authDomain: "camp-nou-planner.firebaseapp.com",
  projectId: "camp-nou-planner",
  storageBucket: "camp-nou-planner.firebasestorage.app",
  messagingSenderId: "621779175149",
  appId: "1:621779175149:web:832ac6c7c2560b889a6ee4",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
