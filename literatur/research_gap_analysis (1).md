Here's a summary of key points from the provided articles, focusing on methodologies for EEG signal processing in brain-computer interface (BCI) applications:

1. **Feature Extraction Techniques**:
   - **Intrinsic Time-Scale Decomposition (ITD)**: Used for feature extraction to enhance EEG signals and improve classification accuracy.
   - **Wavelet Transform**: Applied for feature extraction, achieving high performance with fast response times.
   - **Discrete Wavelet Transform (DWT) & Empirical Mode Decomposition (EMD)**: Combined methods used to extract features from multi-channel EEG data.
   - **Graph Neural Networks (GNNs)**: Utilized for multilevel feature fusion to exploit both local and global neural information.

2. **Classification Methods**:
   - **Support Vector Machine (SVM)**: Widely used for classification tasks, achieving high accuracy in motor imagery tasks.
   - **Linear Discriminant Analysis (LDA) & K-Nearest Neighbors (KNN)**: Compared with SVM to find the most suitable classifier.
   - **Convolutional Neural Networks (CNNs)**: Applied for feature extraction and classification, showing improved performance over traditional methods.
   - **Stacked Long Short-Term Memory Network (LSTM)**: Used for mental arithmetic task classification by reducing electrode numbers.

3. **Feature Selection**:
   - **Correlation-Based Feature Selection (CFS), Minimum Redundancy Maximum Relevance (mRMR), and Multi-Subspace Randomization Collaboration-based Unsupervised Feature Selection (SRCFS)**: Applied to reduce dimensionality and improve classification accuracy.
   - **Layer-Wise Relevance Propagation (LRP)-based feature selection**: Integrated into deep learning models for EEG classification.

4. **Signal Processing Methods**:
   - **Preprocessing & Decomposition**: Involves filtering, decomposition using EMD or DWT to extract meaningful features from raw EEG signals.
   - **Time-Frequency Analysis**: Used in conjunction with spatial analysis (CSP) to capture multi-domain features for motor imagery tasks.

5. **Graph-Based Approaches**:
   - **EEG-Graphs & Graph Neural Networks (GNN)**: Models the topology of the human brain as a graph, enhancing decoding performance.
   - **Feature Rotation and Stacking Ensemble**: Combines multi-domain feature rotation with stacking ensemble for improved classification accuracy.

6. **Noise Reduction Techniques**:
   - **Chaotic Detection Technology**: Applied to detect weak SSVEP features amidst strong noise, improving recognition of BCI-illiterate subjects.
   - **DTP-Net (Densely-connected Temporal Pyramids)**: A fully convolutional neural network for EEG denoising in the time-frequency domain.

7. **Machine Learning & Deep Learning**:
   - **Ensemble Learning**: Achieved high accuracy in finger movement classification by integrating multiple classifiers.
   - **Transfer Learning with Rotation Alignment (RMRA)**: Improved cross-session and cross-subject classification of MI EEG signals using Riemannian mean alignment.

8. **Applications & Evaluation**:
   - **Motor Imagery Classification**: Various methods evaluated on datasets like BCI Competition IV, demonstrating improved accuracy through advanced feature extraction and selection.
   - **Auditory Spatial Attention Detection (ASAD)**: Utilized graph-based models to enhance decoding performance from EEG signals.
   - **Real-Time Control Applications & Smart Home Interfaces**: Applied MI-BCI for real-time control of devices like wheelchairs or smart home systems.

These methodologies highlight the evolving landscape of BCI research, emphasizing the importance of advanced feature extraction and classification techniques in improving system performance.